import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BinaryManager } from '@kaizen/engine';

const CACHE = path.join('/tmp', 'kaizen-binary-unit-tests');

describe('BinaryManager (offline behavior)', () => {
  it('reports unavailable with actionable guidance when nothing is cached', async () => {
    const mgr = new BinaryManager({ cacheDir: CACHE, platform: 'linux', arch: 'x64' });
    const status = await mgr.status();
    expect(status.available).toBe(false);
    expect(status.problems.join(' ')).toMatch(/kaizen setup/);
  });

  it('rejects win32 with WSL guidance, without touching the network', async () => {
    const mgr = new BinaryManager({ cacheDir: CACHE, platform: 'win32', arch: 'x64' });
    const status = await mgr.status();
    expect(status.available).toBe(false);
    expect(status.problems.join(' ')).toMatch(/WSL/);
    await expect(mgr.setup()).rejects.toMatchObject({ code: 'UNSUPPORTED_PLATFORM' });
  });

  it('rejects unsupported platforms', async () => {
    const mgr = new BinaryManager({
      cacheDir: CACHE,
      platform: 'linux',
      arch: 'arm64', // no artifact published for linux-arm64
    });
    const status = await mgr.status();
    expect(status.available).toBe(false);
    expect(status.problems.join(' ')).toMatch(/No Portaldot node artifact/);
    await expect(mgr.setup()).rejects.toMatchObject({ code: 'UNSUPPORTED_PLATFORM' });
  });

  it('reports a corrupt manifest as unavailable (recoverable via setup)', async () => {
    const fs = await import('node:fs');
    const corruptDir = path.join(CACHE, 'corrupt');
    fs.mkdirSync(path.join(corruptDir), { recursive: true });
    fs.writeFileSync(path.join(corruptDir, 'manifest.json'), '{not json');
    const mgr = new BinaryManager({ cacheDir: corruptDir, platform: 'linux', arch: 'x64' });
    const status = await mgr.status();
    expect(status.available).toBe(false);
    expect(status.problems.join(' ')).toMatch(/corrupt/);
    fs.rmSync(corruptDir, { recursive: true, force: true });
  });
});
