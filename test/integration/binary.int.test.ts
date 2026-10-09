/**
 * LIVE test — T-1.3 BinaryManager against the real artifact.
 * Verifies: real download+verify, TOFU manifest, idempotent re-run.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BinaryManager } from '@kaizen/engine';
import { LIVE, testRoot } from './testkit';

describe.runIf(LIVE)('BinaryManager (live, real download)', () => {
  it(
    'downloads, verifies and smoke-checks the real Portaldot binary; re-run is idempotent',
    async () => {
      const dir = testRoot('binary');
      const mgr = new BinaryManager({ cacheDir: path.join(dir, 'cache') });

      // pre-condition: not available
      const before = await mgr.status();
      expect(before.available).toBe(false);

      const entry = await mgr.setup();
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.sizeBytes).toBeGreaterThan(5 * 1024 * 1024);
      expect(entry.platform).toBe(`${process.platform}-${process.arch}`);
      expect(entry.binaryVersion).toContain('portaldot');
      expect(entry.sourceUrl).toMatch(/^https:\/\/github\.com\/portaldotVolunteer\/Portaldot-node\//);

      // binaries exist and execute
      expect(fs.existsSync(mgr.nodePath())).toBe(true);
      expect(fs.statSync(mgr.nodePath()).size).toBeGreaterThan(1024 * 1024);

      const status = await mgr.status();
      expect(status.available).toBe(true);
      expect(status.entry?.sha256).toBe(entry.sha256);

      // idempotent: cached tarball NOT re-downloaded (mtime unchanged)
      const tarball = path.join(mgr.downloadDir, path.basename(new URL(entry.sourceUrl).pathname));
      const mtimeBefore = fs.statSync(tarball).mtimeMs;
      const entry2 = await mgr.setup();
      const mtimeAfter = fs.statSync(tarball).mtimeMs;
      expect(entry2.sha256).toBe(entry.sha256);
      expect(mtimeAfter).toBe(mtimeBefore);

      fs.rmSync(dir, { recursive: true, force: true });
    },
    300_000,
  );
});
