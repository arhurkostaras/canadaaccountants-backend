// modules/referrals/index.js
// Composition root for the referral rail. server.js has exactly three touchpoints:
//
//   const referrals = require('./modules/referrals')({
//     pool,                       // singleton pg Pool
//     sendEmail,                  // services/email.js sendEmail
//     stripe,                     // stripe client (Phase 3 use only)
//     auth: { authenticateToken, requireCPA },
//     matcher: { runMatch: runCPAMatchingAlgorithm },   // ACC scorer, injected
//     validateEmail,              // optional ZeroBounce wrapper (see below)
//     captureError,               // optional Sentry captureException wrapper
//   });
//   app.use(referrals.networkRouter);        // HMAC server-to-server surface
//   app.use(referrals.professionalRouter);   // JWT dashboard API
//   app.use(referrals.adminRouter);          // paths are /api/admin/* — the existing
//                                            // admin umbrella middleware gates them by prefix
//   await referrals.ensureSchema();          // boot (new tables only)
//   referrals.startWorkers();                // outbox flush + sweeper cron
//
// validateEmail(email) contract: resolve { blocked: true } for invalid/disposable,
// { circuitOpen: true } when the ZeroBounce breaker is open, or falsy/{} when fine.

'use strict';

const config = require('./config');
const service = require('./service');
const network = require('./network');
const schema = require('./schema');
const { buildNotify } = require('./emails');
const { buildIncentives } = require('./incentives');
const buildNetworkRoutes = require('./routes.network');
const buildProfessionalRoutes = require('./routes.professional');
const buildAdminRoutes = require('./routes.admin');
const accAdapter = require('./adapters/acc');
const lawAdapter = require('./adapters/law');

function createReferralModule(injected) {
  const { pool, sendEmail, stripe, auth, matcher, validateEmail, captureError } = injected;
  if (!pool) throw new Error('[referrals] pool is required');

  const notify = buildNotify({ config, sendEmail, service, captureError });
  const incentives = buildIncentives({ config, stripe, service, captureError });

  // Per-platform matcher adapter. ACC + LAW are implemented; INV/CBE supply
  // their own adapter file when the module lands in those repos.
  const adapter = config.PLATFORM_ID === 'ACC'
    ? accAdapter.buildAdapter(matcher || {})
    : config.PLATFORM_ID === 'LAW'
    ? lawAdapter.buildAdapter(matcher || {})
    : {
        matchInbound: async () => {
          throw new Error(`[referrals] no matcher adapter for ${config.PLATFORM_ID} yet`);
        },
      };

  // The deps graph every service call receives.
  const deps = {
    notify,
    incentives,
    validateEmail,
    captureError,
    matchInbound: adapter.matchInbound,
    enqueuePeerStatus: network.enqueuePeerStatus,
  };

  // Bind service entry points with deps so route files stay thin.
  const boundService = {
    ...service,
    createReferral: (p, c, input) => service.createReferral(p, c, input, deps),
    createPlatformReferral: (p, c, payload) => service.createPlatformReferral(p, c, payload, deps),
    acceptReferral: (p, c, id, proId, d) => service.acceptReferral(p, c, id, proId, d || deps),
    declineReferral: (p, c, id, proId, reason, d) => service.declineReferral(p, c, id, proId, reason, d || deps),
    markConnected: (p, c, id, proId, d) => service.markConnected(p, c, id, proId, d || deps),
    matchInboundReferral: (p, c, id) => service.matchInboundReferral(p, c, id, deps),
    convertReferral: (p, c, id, opts) => service.convertReferral(p, c, id, opts, deps),
    // receiveReferral needs post-receipt matching: wrap so the network route
    // triggers match after a NEW inbound row (not on idempotent duplicates).
    receiveReferral: async (p, c, payload, sourcePlatform) => {
      const result = await service.receiveReferral(p, c, payload, sourcePlatform);
      if (result.created && result.referralId) {
        try {
          await service.matchInboundReferral(p, c, result.referralId, deps);
        } catch (err) {
          // Receipt succeeded; matching failure is recorded and retried by ops,
          // never bubbled into a 500 that would make the sender re-deliver.
          console.error('[referrals] post-receive match error:', err.message);
          if (typeof captureError === 'function') {
            try { captureError(err, { context: 'post-receive match' }); } catch (e) { console.error('[referrals] captureError failed:', e.message); }
          }
        }
      }
      return result;
    },
  };

  const networkRouter = buildNetworkRoutes({ pool, config, service: boundService, captureError });
  const professionalRouter = buildProfessionalRoutes({ pool, config, service: boundService, deps, auth: auth || {} });
  const adminRouter = buildAdminRoutes({ pool, config, service: boundService, incentives });

  let workerHandles = null;
  function startWorkers() {
    if (workerHandles) return workerHandles; // idempotent - never double-start
    workerHandles = {
      outbox: network.startOutboxWorker(pool, config, deps),
      sweeper: network.startSweeper(pool, config, service, deps),
    };
    return workerHandles;
  }

  return {
    config,
    service: boundService,
    deps,
    incentives,
    notify,
    networkRouter,
    professionalRouter,
    adminRouter,
    getStatusSummary: () => buildAdminRoutes.getStatusSummary(pool),
    ensureSchema: () => schema.ensureReferralSchema(pool),
    startWorkers,
    flushOutboxOnce: () => network.flushOutbox(pool, config, deps), // used by the self-test
  };
}

module.exports = createReferralModule;
