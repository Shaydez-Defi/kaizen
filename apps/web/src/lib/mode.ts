/**
 * Hosted build flag. `VITE_KAIZEN_PUBLIC=1` (the Vercel deployment) has no
 * Kaizen engine behind it, so the console runs in REPLAY MODE: every screen
 * is filled from real recorded drills (GitHub Actions bundles on the
 * `demo-data` branch, evidence committed under docs/evidence) and live
 * read-only Portaldot V3 RPC. Mutating actions are refused, never faked.
 */
export const REPLAY: boolean = import.meta.env?.['VITE_KAIZEN_PUBLIC'] === '1';

export const REPLAY_REFUSAL =
  'Replay mode: drills run on a fresh GitHub runner. Use “Run a drill” on the Live page (or it runs automatically every 3 hours).';
