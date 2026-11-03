#!/usr/bin/env node
// API gate for nestjs-multi-storage: run `npm run build` first, then `npm run check:api`.
// 1. type-level identity with the 0.8.0 declarations (check.ts), 2. identical runtime export names.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');

execFileSync(process.execPath, [tsc, '-p', path.join(__dirname, 'tsconfig.json')], { stdio: 'inherit' });
console.log('types: public API identical to 0.8.0');

const expected = fs.readFileSync(path.join(__dirname, 'baseline-0.8.0/runtime-exports.txt'), 'utf8').trim().split(/,\s*/).sort();
const actual = Object.keys(require(path.join(root, 'packages', 'nestjs', 'dist', 'index.js'))).sort();
if (JSON.stringify(expected) !== JSON.stringify(actual)) {
  console.error(`runtime exports differ.\n  0.8.0:   ${expected.join(', ')}\n  current: ${actual.join(', ')}`);
  process.exit(1);
}
console.log(`runtime exports identical: ${actual.join(', ')}`);
