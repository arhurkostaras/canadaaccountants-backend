/**
 * ESLint rule: sentry-before-express
 *
 * Backpressure ledger: BP-002
 * Invariant: in the server entry file, Sentry must be initialized before
 * Express is loaded. If express is required before Sentry.init() runs, any
 * error thrown during Express setup is never captured.
 *
 * Scope this rule to entry files only (see wiring notes), e.g. server.js.
 * Handles both CommonJS (require) and ESM (import).
 *
 * Options (object, optional):
 *   { "requireInit": true }  // default true: also fail if Sentry.init() is
 *                            // missing entirely in the entry file.
 */

'use strict';

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require Sentry to be initialized before Express is loaded in the entry file',
      recommended: true,
    },
    schema: [
      {
        type: 'object',
        properties: { requireInit: { type: 'boolean' } },
        additionalProperties: false,
      },
    ],
    messages: {
      sentryRequireAfterExpress:
        "'@sentry/node' is loaded after 'express'. Errors thrown while Express is setting up will be missed. Fix: move the @sentry/node import above the express import.",
      initAfterExpress:
        "Sentry.init() runs after 'express' is loaded, so errors during Express setup are not captured. Fix: call Sentry.init() before the express import. Expected order: import @sentry/node, call Sentry.init(), then import express.",
      initMissing:
        "This entry file loads 'express' but never calls Sentry.init(). Setup-time errors are uninstrumented. Fix: initialize Sentry before importing express.",
    },
  },

  create(context) {
    const options = context.options[0] || {};
    const requireInit = options.requireInit !== false; // default true

    let expressLoad = null; // node where express is first loaded
    let sentryLoad = null; // node where @sentry/node is first loaded
    let sentryBinding = null; // local name bound to @sentry/node
    let sentryInit = null; // node for the Sentry.init() call

    const pos = (node) => node.range[0];

    // record the first load of a given package, CommonJS or ESM
    function recordLoad(source, node, bindingName) {
      if (source === 'express' && !expressLoad) {
        expressLoad = node;
      } else if (source === '@sentry/node' && !sentryLoad) {
        sentryLoad = node;
        if (bindingName) sentryBinding = bindingName;
      }
    }

    return {
      // ESM: import express from 'express'  /  import * as Sentry from '@sentry/node'
      ImportDeclaration(node) {
        const source = node.source && node.source.value;
        let bindingName = null;
        const def = node.specifiers && node.specifiers[0];
        if (def && def.local) bindingName = def.local.name;
        recordLoad(source, node, bindingName);
      },

      // CommonJS: const express = require('express')
      CallExpression(node) {
        const callee = node.callee;

        // require('...')
        if (callee.type === 'Identifier' && callee.name === 'require') {
          const arg = node.arguments[0];
          if (arg && arg.type === 'Literal' && typeof arg.value === 'string') {
            // walk up to the variable name if present
            let bindingName = null;
            const parent = node.parent;
            if (
              parent &&
              parent.type === 'VariableDeclarator' &&
              parent.id &&
              parent.id.type === 'Identifier'
            ) {
              bindingName = parent.id.name;
            }
            recordLoad(arg.value, node, bindingName);
          }
          return;
        }

        // Sentry.init(...) — match the bound name, or fall back to a literal 'Sentry'
        if (
          callee.type === 'MemberExpression' &&
          callee.property &&
          callee.property.name === 'init' &&
          callee.object &&
          callee.object.type === 'Identifier'
        ) {
          const objName = callee.object.name;
          if (objName === sentryBinding || objName === 'Sentry') {
            if (!sentryInit) sentryInit = node;
          }
        }
      },

      'Program:exit'() {
        if (!expressLoad) return; // not an Express entry file; nothing to enforce

        if (sentryLoad && pos(sentryLoad) > pos(expressLoad)) {
          context.report({ node: sentryLoad, messageId: 'sentryRequireAfterExpress' });
        }

        if (sentryInit) {
          if (pos(sentryInit) > pos(expressLoad)) {
            context.report({ node: sentryInit, messageId: 'initAfterExpress' });
          }
        } else if (requireInit) {
          context.report({ node: expressLoad, messageId: 'initMissing' });
        }
      },
    };
  },
};
