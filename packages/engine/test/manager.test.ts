import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isPidAlive, pidFileFor, readLogTail } from '@kaizen/engine';

describe('isPidAlive', () => {
  it('treats pid <= 0 as never alive (0/-1 have process-GROUP kill semantics)', () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(-42)).toBe(false);
    expect(isPidAlive(1.5)).toBe(false);
    expect(isPidAlive(Number.NaN)).toBe(false);
  });

  it('reports our own pid as alive and a huge impossible pid as dead', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(2 ** 31 - 1)).toBe(false); // beyond valid pid range
  });
});

describe('readLogTail', () => {
  it('returns the tail lines of a log file and [] for missing files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaizen-logtail-'));
    const log = path.join(dir, 'n.log');
    expect(readLogTail(log)).toEqual([]);
    fs.writeFileSync(log, 'line1\nline2\nline3\n');
    expect(readLogTail(log)).toEqual(['line1', 'line2', 'line3']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('pidFileFor', () => {
  it('is stable inside the base dir', () => {
    expect(pidFileFor('/x/y')).toBe(path.join('/x/y', 'kaizen-node.pid'));
  });
});
