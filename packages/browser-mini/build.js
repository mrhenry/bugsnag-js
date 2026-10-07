#!/usr/bin/env node
'use strict'

/*
 * Builds `browser-mini` by doing the only two things that are still needed:
 *
 *   1. substitute `__VERSION__` with the package version
 *   2. minify
 *
 * The source is an ES module with named exports, so there is no bundling,
 * wrapping or transpilation step and no runtime/helper bloat is introduced.
 * The minifier is told to mangle top-level identifiers and private (`_`)
 * properties while preserving the exported names.
 */

const { readFileSync, writeFileSync } = require('fs')
const { join } = require('path')
const { execFileSync } = require('child_process')

const dir = __dirname
const min = process.argv.indexOf('--minify') !== -1
const version = require(join(dir, 'package.json')).version

const source = readFileSync(join(dir, 'src/bugsnag.js'), 'utf8')
  .replace(/__VERSION__/g, version)

if (!min) {
  writeFileSync(join(dir, 'dist/bugsnag.js'), source)
} else {
  const out = join(dir, 'dist/bugsnag.min.js')
  const uglify = join(dir, '../../node_modules/.bin/uglifyjs')
  execFileSync(uglify, [
    '--compress', 'passes=3',
    '--mangle', 'toplevel',
    '--mangle-props', 'regex=/^_/',
    '--ie8',
    '--output', out
  ], { input: source, stdio: ['pipe', 'inherit', 'inherit'] })
}
