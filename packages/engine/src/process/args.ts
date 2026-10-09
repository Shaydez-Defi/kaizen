/**
 * Node argument builder.
 *
 * Translates a typed node configuration into the exact argv for portaldot_dev.
 * Safety invariants (DEC-004), enforced here and re-checked by
 * assertSafeArgs() immediately before spawn:
 *  - argv array only, never a shell string
 *  - NEVER `--tmp` (and therefore never `--tmp` with `--base-path`)
 *  - NEVER external/unsafe RPC exposure flags
 *  - always an explicit `--base-path`
 */

import { KaizenError } from '../errors';
import type { NodePorts, WellKnownKey } from '../types';

export interface NodeLaunchSpec {
  /** Node display name (only used when no well-known key is set). */
  name: string;
  baseDir: string;
  ports: NodePorts;
  /** 'dev' → `--dev`; otherwise a generated raw chain spec path. */
  chain: 'dev' | { specPath: string };
  wellKnownKey?: WellKnownKey;
  bootnodes?: string[];
  nodeKeyFile: string;
  /** Extra validator intent (well-known keys already imply --validator). */
  validator?: boolean;
}

const WELL_KNOWN_FLAGS: Record<WellKnownKey, string> = {
  alice: '--alice',
  bob: '--bob',
  charlie: '--charlie',
  dave: '--dave',
  eve: '--eve',
  ferdie: '--ferdie',
  one: '--one',
  two: '--two',
};

/** Flags that must never appear in generated argv. */
export const FORBIDDEN_FLAGS = [
  '--tmp',
  '--rpc-external',
  '--unsafe-rpc-external',
  '--ws-external',
  '--unsafe-ws-external',
  '--prometheus-external',
] as const;

export function buildNodeArgs(spec: NodeLaunchSpec): string[] {
  const args: string[] = [];

  // Chain selection first (deterministic ordering aids diffing and tests).
  if (spec.chain === 'dev') {
    args.push('--dev');
  } else {
    args.push('--chain', spec.chain.specPath);
  }

  // Identity / role. Well-known keys imply `--name X --validator` + keystore
  // session keys (verified from the real binary's --help, R-02); do not pass
  // --name alongside them.
  if (spec.wellKnownKey) {
    args.push(WELL_KNOWN_FLAGS[spec.wellKnownKey]);
  } else {
    args.push('--name', spec.name);
    if (spec.validator) args.push('--validator');
  }

  args.push('--base-path', spec.baseDir);
  args.push('--port', String(spec.ports.p2p));
  args.push('--rpc-port', String(spec.ports.rpc));
  args.push('--ws-port', String(spec.ports.ws));
  args.push('--prometheus-port', String(spec.ports.prometheus));
  args.push('--node-key-file', spec.nodeKeyFile);
  args.push('--no-telemetry');

  for (const bootnode of spec.bootnodes ?? []) {
    args.push('--bootnodes', bootnode);
  }

  assertSafeArgs(args);
  return args;
}

/**
 * Defense in depth: refuse to spawn argv that violates our safety invariants.
 * Throws INVALID_INPUT with the offending flag.
 */
export function assertSafeArgs(args: readonly string[]): void {
  for (const flag of FORBIDDEN_FLAGS) {
    if (args.includes(flag)) {
      throw new KaizenError(
        'INVALID_INPUT',
        `Refusing to spawn node: forbidden flag ${flag} in argv`,
        { flag },
      );
    }
  }
  if (!args.includes('--base-path')) {
    throw new KaizenError(
      'INVALID_INPUT',
      'Refusing to spawn node: --base-path is required (nodes must have isolated data dirs)',
    );
  }
}

/** Build the WebSocket RPC URL for a node's allocated port. */
export function wsUrlForPort(port: number): string {
  return `ws://127.0.0.1:${port}`;
}

/** Build the HTTP RPC URL for a node's allocated port. */
export function httpUrlForPort(port: number): string {
  return `http://127.0.0.1:${port}`;
}
