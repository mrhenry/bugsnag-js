const path = require('path')

const rootDir = path.resolve(__dirname, '../..')

// Every first-party module that ends up in the browser-lite bundle. Third-party
// dependencies (error-stack-parser, stackframe, stack-generator,
// safe-json-stringify, iserror, cuid) are exercised through these modules but
// are not instrumented here.
const bundleSources = [
  'packages/browser-lite/src/**/*.js',
  'packages/core/client.js',
  'packages/core/event.js',
  'packages/core/config.js',
  'packages/core/breadcrumb.js',
  'packages/core/session.js',
  'packages/core/lib/async-every.js',
  'packages/core/lib/breadcrumb-types.js',
  'packages/core/lib/callback-runner.js',
  'packages/core/lib/error-stack-parser.js',
  'packages/core/lib/feature-flag-delegate.js',
  'packages/core/lib/has-stack.js',
  'packages/core/lib/iserror.js',
  'packages/core/lib/json-payload.js',
  'packages/core/lib/metadata-delegate.js',
  'packages/core/lib/sync-callback-runner.js',
  'packages/core/lib/es-utils/*.js',
  'packages/core/lib/validators/*.js',
  'packages/delivery-xml-http-request/delivery.js',
  'packages/plugin-window-onerror/onerror.js',
  'packages/plugin-window-unhandled-rejection/unhandled-rejection.js',
  'packages/plugin-browser-context/context.js',
  'packages/plugin-browser-request/request.js',
  'packages/plugin-simple-throttle/throttle.js',
  'packages/plugin-console-breadcrumbs/console-breadcrumbs.js',
  'packages/plugin-strip-query-string/strip-query-string.js'
]

module.exports = {
  rootDir,
  testEnvironment: '<rootDir>/jest/FixJSDOMEnvironment.js',
  testMatch: ['<rootDir>/packages/browser-lite/test/**/*.test.[jt]s?(x)'],
  modulePathIgnorePatterns: ['.verdaccio', 'dist', 'examples', 'fixtures'],
  // rootMode: 'upward' lets babel find the repo-root babel.config.js even when
  // this config is invoked from the package directory
  transform: {
    '^.+\\.[jt]sx?$': ['babel-jest', { rootMode: 'upward' }]
  },
  collectCoverageFrom: bundleSources,
  coverageReporters: ['text', 'json-summary']
}
