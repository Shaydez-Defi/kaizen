#!/usr/bin/env node
// Committed bin shim (T-3.6C) so `npm install` links `kaizen` into
// node_modules/.bin even before the TypeScript build exists; after
// `npm run build`, `npx kaizen <command>` runs the built CLI from the repo.
'use strict';
try {
  require('../dist/index.js');
} catch (e) {
  if (e && e.code === 'MODULE_NOT_FOUND' && String(e.message).includes('dist')) {
    console.error('kaizen: CLI not built yet — run `npm run build` in the repo root first.');
    process.exitCode = 1;
  } else {
    throw e;
  }
}
