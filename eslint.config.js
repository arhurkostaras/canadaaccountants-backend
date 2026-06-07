// eslint.config.js
// BP-002 (see BACKPRESSURE_LEDGER.md): enforce Sentry.init() before the express
// import in the server entry file. Flat config (ESLint 9). The local rule is
// registered inline as a plugin, scoped to server.js only, at error severity.
const sentryBeforeExpress = require('./eslint-rules/sentry-before-express');

module.exports = [
  {
    files: ['server.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
    },
    plugins: {
      local: { rules: { 'sentry-before-express': sentryBeforeExpress } },
    },
    rules: {
      'local/sentry-before-express': 'error',
    },
  },
];
