const path = require('path')

const rootDir = path.resolve(__dirname, '../..')

// The whole browser-lite bundle is the single self-contained source file.
const bundleSources = [
  'packages/browser-lite/src/**/*.js'
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
