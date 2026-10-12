/**
 * Secret redaction for fault evidence, errors, and events (FR-7).
 *
 * Defense in depth: fault evidence is structurally typed (pids, timestamps,
 * RPC observations) and the injector never captures argv, env, or key
 * material — this scrubber additionally strips anything secret-shaped from
 * strings that pass through (error messages, adapter detail strings).
 */

const SECRET_PATTERNS: RegExp[] = [
  // PEM private key blocks
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // secret-bearing flags/assignments: --password-filename X, password=…, key: …
  /--(?:node-key|password|keystore)[-\w]*(?:[= ])\S+/gi,
  /\b(?:password|passwd|secret|mnemonic|seed[_ -]?phrase|keystore[_ -]?password|private[_ -]?key)\b\s*[:=]\s*\S+/gi,
];

/** Object keys whose entire value is secret material by naming convention. */
const SECRET_KEY_PATTERN =
  /password|passwd|secret|mnemonic|seed|passphrase|keystore|private[_ -]?key|credential|token/i;

/** Strip secret-shaped content from a string (best-effort, never throws). */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]');
  return out;
}

/** Deep-redact every string in a JSON-ish value (returns a new value). */
export function redactDeep<T>(value: T): T {
  return redactValue(value) as T;
}

function redactValue(value: unknown, key?: string): unknown {
  if (key && SECRET_KEY_PATTERN.test(key)) return '[redacted]';
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(v, k);
    return out;
  }
  return value;
}
