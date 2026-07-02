#!/usr/bin/env node
// Paid-flow smoke (UX audit 2026-07-02): the paid-onboarding chain silently
// dead-ended because email CTAs pointed at pages that never existed and no
// credentials were ever issued. This guards the chain:
//   1. Every FRONTEND_URL-relative link inside server.js email templates must
//      resolve (<400) on the live frontend.
//   2. The critical member pages must serve 200.
//   3. The live dashboard must not bounce unauthenticated members to the
//      admin console.
import { readFileSync } from 'node:fs';

const FRONTEND = process.env.FRONTEND_URL || 'https://canadaaccountants.app';
const BACKEND = process.env.BACKEND_URL || 'https://canadaaccountants-backend-production-1d8f.up.railway.app';
const failures = [];

// Documented exceptions - visible, never silent. /claim is the MAGIC-LINK-001
// known bug (dark-gated sender, wire-up-or-remove decision pending).
const KNOWN_DEAD = { '/claim': 'MAGIC-LINK-001' };

async function status(url) {
  try {
    const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
    return r.status;
  } catch { return 0; }
}

// 1. Email-template links: ${FRONTEND_URL}/path occurrences in server.js.
const src = readFileSync('server.js', 'utf8');
const paths = [...new Set([...src.matchAll(/\$\{FRONTEND_URL\}(\/[a-z0-9\-\/]*)/gi)].map(m => m[1]))]
  .filter(p => !p.includes('${'));
for (const p of paths) {
  const s = await status(FRONTEND + p);
  if (KNOWN_DEAD[p]) { console.log(`email link ${p}: ${s} (allowlisted: ${KNOWN_DEAD[p]})`); continue; }
  console.log(`email link ${p}: ${s}`);
  if (s === 0 || s >= 400) failures.push(`email template links ${p} -> ${s}`);
}

// Backend-origin template links (e.g. the email-keyed unsubscribe): the route
// must exist (anything but 404/unreachable passes - parameterless probes may 400).
// Paths ending in '/' are interpolated prefixes like /api/c/${token}. Probe the
// bare prefix first; on 404 retry with a dummy segment so the param route can
// match. (Bare-first matters for /api/unsubscribe/: an unknown token triggers a
// legacy full-table LIKE fallback that runs 30s+, while the bare prefix resolves
// against the email-keyed route via Express non-strict trailing-slash matching.)
const bpaths = [...new Set([...src.matchAll(/\$\{BACKEND_URL\}(\/[a-z0-9\-\/]*)/gi)].map(m => m[1]))];
for (const p of bpaths) {
  let s = await status(BACKEND + p);
  if (s === 404 && p.endsWith('/')) s = await status(BACKEND + p + 'smoke-probe-invalid');
  console.log(`backend email link ${p}: ${s}`);
  if (s === 0 || s === 404) failures.push(`backend template link ${p} -> ${s}`);
}

// 2. Critical member chain.
for (const p of ['/cpa-login', '/reset-password', '/forgot-password', '/dashboard', '/cpa-dashboard', '/checkout-success']) {
  const s = await status(FRONTEND + p);
  console.log(`chain ${p}: ${s}`);
  if (s !== 200) failures.push(`chain page ${p} -> ${s} (expected 200)`);
}

// 3. Unauth dashboard must not route to the admin console.
try {
  const html = await (await fetch(FRONTEND + '/cpa-dashboard', { signal: AbortSignal.timeout(20000) })).text();
  if (html.includes("'/admin.html'") || html.includes('"/admin.html"')) {
    failures.push('cpa-dashboard still routes unauthenticated members to /admin.html');
  } else {
    console.log('dashboard unauth redirect: not admin (ok)');
  }
} catch (e) { failures.push('cpa-dashboard fetch failed: ' + e.message); }

if (failures.length) {
  console.error('\nPAID-FLOW SMOKE FAILED:');
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log('\npaid-flow smoke OK');
