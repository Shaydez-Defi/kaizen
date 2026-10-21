#!/usr/bin/env node
/**
 * kaizen — CLI entry point.
 *
 * The command tree and all action logic live in ./program.ts (exported as
 * buildProgram(), with an engine-factory DI seam so tests can drive real
 * commands in-process). This file only wires argv parsing and the last-resort
 * error net.
 *
 * Output contract:
 *  - human-readable text by default
 *  - `--json` for machine-readable output (stable envelope)
 *  - exit code 0 on success, 1 on any failure
 */

import { buildProgram } from './program';

buildProgram()
  .parseAsync(process.argv)
  .catch((e: unknown) => {
    // Last-resort net: commander errors normally exit before this; anything
    // reaching here is unexpected and must not be swallowed.
    console.error(`ERROR [INTERNAL] ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
