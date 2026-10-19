/**
 * V3 endpoint configuration (T-8.1, Phase 8).
 *
 * Official Portaldot V3 endpoints are CONFIGURATION DEFAULTS, never
 * immutable constants: every value can be overridden per-call (explicit
 * options win) or per-environment (`KAIZEN_V3_*`), following the engine's
 * `explicit ?? process.env ?? default` convention (resolveDataDir).
 *
 * Security posture:
 *  - Configuration only ever comes from explicit options or environment —
 *    never from a request body or any caller-supplied URL, so this probe
 *    cannot be steered into scanning arbitrary targets (DEC-023).
 *  - Validation failures name the CONFIGURATION KEY, never the value
 *    (env values may be credential-bearing).
 *  - `redactEndpointUrl()` reduces a URL to its origin for every result,
 *    log line, and error message — userinfo, path, query, and fragment
 *    never leave the config object (credential-bearing URLs stay in
 *    memory only, see V3_ENDPOINT_DEFAULTS for the trusted defaults).
 */

import { z } from 'zod';
import { KaizenError } from '../errors';

/** Official Portaldot V3 endpoints (configuration defaults, overridable). */
export const V3_ENDPOINT_DEFAULTS = {
  substrateWs: 'wss://test-node-v3.portaldot.dev',
  evmRpc: 'https://test-evm-rpc-v3.portaldot.dev',
  explorer: 'https://node-console.portaldot.dev',
  /** Expected EVM chain id of the V3 test network. */
  evmChainId: 420420777,
  /** Per-endpoint bounded probe deadline. */
  probeTimeoutMs: 15_000,
} as const;

/** Environment override keys (documented; values are never echoed back). */
export const V3_ENV_KEYS = {
  substrateWs: 'KAIZEN_V3_SUBSTRATE_WS',
  evmRpc: 'KAIZEN_V3_EVM_RPC',
  explorer: 'KAIZEN_V3_EXPLORER',
  evmChainId: 'KAIZEN_V3_EVM_CHAIN_ID',
  probeTimeoutMs: 'KAIZEN_V3_PROBE_TIMEOUT_MS',
} as const;

export interface V3EndpointConfig {
  substrateWsUrl: string;
  evmRpcUrl: string;
  explorerUrl: string;
  expectedEvmChainId: number;
  probeTimeoutMs: number;
}

const urlField = z
  .string()
  .min(1)
  .max(2_048)
  .refine(
    (value) => {
      try {
        const u = new URL(value);
        return ['ws:', 'wss:', 'http:', 'https:'].includes(u.protocol);
      } catch {
        return false;
      }
    },
    { message: 'must be an absolute ws:/wss:/http:/https: URL' },
  );

const v3ConfigSchema = z.object({
  substrateWsUrl: urlField,
  evmRpcUrl: urlField,
  explorerUrl: urlField,
  expectedEvmChainId: z.number().int().min(1).max(0xffffffff),
  probeTimeoutMs: z.number().int().min(500).max(120_000),
});

function envNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN; // NaN forces the schema to reject
}

/** Treat unset and empty alike (a shell can export a key with no value). */
function envString(raw: string | undefined): string | undefined {
  return raw !== undefined && raw.trim() !== '' ? raw : undefined;
}

/**
 * Resolve the effective V3 configuration. Precedence per field:
 * explicit option > environment > trusted default. Throws INVALID_INPUT
 * when the combination is invalid — the message lists failing KEYS and
 * constraints only, never the offending value.
 */
export function resolveV3Config(explicit: Partial<V3EndpointConfig> = {}): V3EndpointConfig {
  const candidate: V3EndpointConfig = {
    substrateWsUrl:
      explicit.substrateWsUrl ??
      envString(process.env[V3_ENV_KEYS.substrateWs]) ??
      V3_ENDPOINT_DEFAULTS.substrateWs,
    evmRpcUrl:
      explicit.evmRpcUrl ?? envString(process.env[V3_ENV_KEYS.evmRpc]) ?? V3_ENDPOINT_DEFAULTS.evmRpc,
    explorerUrl:
      explicit.explorerUrl ??
      envString(process.env[V3_ENV_KEYS.explorer]) ??
      V3_ENDPOINT_DEFAULTS.explorer,
    expectedEvmChainId:
      explicit.expectedEvmChainId ??
      envNumber(process.env[V3_ENV_KEYS.evmChainId]) ??
      V3_ENDPOINT_DEFAULTS.evmChainId,
    probeTimeoutMs:
      explicit.probeTimeoutMs ??
      envNumber(process.env[V3_ENV_KEYS.probeTimeoutMs]) ??
      V3_ENDPOINT_DEFAULTS.probeTimeoutMs,
  };
  const parsed = v3ConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    const keys = [...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(root)'))];
    throw new KaizenError(
      'INVALID_INPUT',
      `Invalid V3 endpoint configuration (keys: ${keys.join(', ')}). ` +
        'Constraints: URLs must be absolute ws:/wss:/http:/https: within 2048 chars; ' +
        'expectedEvmChainId must be an integer in 1..4294967295; probeTimeoutMs in 500..120000. ' +
        'Values are withheld from this message.',
      { keys, hint: `check ${Object.values(V3_ENV_KEYS).join(', ')} and explicit options` },
    );
  }
  return parsed.data;
}

/**
 * Reduce a URL to its origin (scheme://host[:port]) for results, logs, and
 * error messages: userinfo, path, query, and fragment are stripped.
 * Unparseable input becomes '[invalid-url]' — never echoed back raw.
 */
export function redactEndpointUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '[invalid-url]';
  }
}
