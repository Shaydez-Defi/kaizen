/**
 * BinaryManager — acquisition and verification of the Portaldot node binary.
 *
 * Policy (DEC-007 + Phase 1 brief):
 *  - Official artifact URLs only, selected from a FROZEN table by platform.
 *    User-supplied URLs/paths are never accepted or executed.
 *  - setup() is the ONLY method that downloads; it must be called explicitly
 *    (`kaizen setup`). Ordinary engine/network operations only *check*
 *    availability and fail with BINARY_NOT_AVAILABLE + guidance.
 *  - SHA-256 is recorded trust-on-first-use in a local manifest; the cached
 *    tarball is kept so the hash can be re-verified on every setup() call.
 *  - The artifact is validated (size sanity, expected files present and
 *    executable) BEFORE the binary is executed for its --version check.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { KaizenError } from '../errors';

export type BinaryChannel = 'testnet';

export interface BinaryManifestEntry {
  platform: string;
  channel: BinaryChannel;
  sourceUrl: string;
  sha256: string;
  sizeBytes: number;
  fetchedAt: string;
  /** Output of `<node> --version`, e.g. "portaldot_dev 2.0.0-unknown-x86_64-linux-gnu". */
  binaryVersion: string;
  files: { node: string; subkey: string };
}

export interface BinaryStatus {
  available: boolean;
  entry?: BinaryManifestEntry;
  problems: string[];
}

export interface BinaryManagerOptions {
  cacheDir: string;
  /** Overridable for tests. */
  platform?: NodeJS.Platform;
  arch?: string;
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof spawn;
}

/**
 * FROZEN artifact table — official Portaldot node distribution only.
 * (Verified in Phase 0 via GitHub API listing of portaldotVolunteer/Portaldot-node.)
 */
const ARTIFACTS: Record<string, { url: string; channel: BinaryChannel }> = {
  'linux-x64': {
    url: 'https://github.com/portaldotVolunteer/Portaldot-node/raw/main/portaldot-testnet-ubuntu.tar.gz',
    channel: 'testnet',
  },
  'darwin-x64': {
    url: 'https://github.com/portaldotVolunteer/Portaldot-node/raw/main/portaldot-testnet-macos.tar.gz',
    channel: 'testnet',
  },
  'darwin-arm64': {
    url: 'https://github.com/portaldotVolunteer/Portaldot-node/raw/main/portaldot-testnet-macos.tar.gz',
    channel: 'testnet',
  },
};

const MIN_ARTIFACT_BYTES = 5 * 1024 * 1024; // real tarballs are ~25–30 MB
const MIN_BINARY_BYTES = 1024 * 1024; // node binary alone is several MB

export class BinaryManager {
  private readonly cacheDir: string;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly fetchImpl: typeof fetch;
  private readonly spawnImpl: typeof spawn;

  constructor(options: BinaryManagerOptions) {
    this.cacheDir = options.cacheDir;
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.spawnImpl = options.spawnImpl ?? spawn;
  }

  get downloadDir(): string {
    return path.join(this.cacheDir, 'downloads');
  }
  get binDir(): string {
    return path.join(this.cacheDir, 'bin');
  }
  get manifestPath(): string {
    return path.join(this.cacheDir, 'manifest.json');
  }

  private platformKey(): string {
    return `${this.platform}-${this.arch}`;
  }

  private artifactFor(): { url: string; channel: BinaryChannel } {
    if (this.platform === 'win32') {
      throw new KaizenError(
        'UNSUPPORTED_PLATFORM',
        'Windows is not supported for local node operations: upstream ships no Windows binary. Run Kaizen inside WSL (see docs/TECHNICAL_RESEARCH.md R-20).',
        { platform: this.platform },
      );
    }
    const artifact = ARTIFACTS[this.platformKey()];
    if (!artifact) {
      throw new KaizenError(
        'UNSUPPORTED_PLATFORM',
        `No Portaldot node artifact for platform ${this.platformKey()}. Supported: ${Object.keys(ARTIFACTS).join(', ')}.`,
        { platform: this.platformKey(), supported: Object.keys(ARTIFACTS) },
      );
    }
    return artifact;
  }

  nodePath(): string {
    return path.join(this.binDir, 'portaldot_dev');
  }
  subkeyPath(): string {
    return path.join(this.binDir, 'subkey');
  }

  /** Non-downloading availability check (safe to call at any time). */
  async status(): Promise<BinaryStatus> {
    const problems: string[] = [];
    let entry: BinaryManifestEntry | undefined;

    try {
      this.artifactFor();
    } catch (e) {
      return { available: false, problems: [e instanceof Error ? e.message : String(e)] };
    }

    if (!fs.existsSync(this.manifestPath)) {
      problems.push('no manifest — run `kaizen setup` to download the Portaldot node binary');
      return { available: false, problems };
    }
    try {
      entry = JSON.parse(fs.readFileSync(this.manifestPath, 'utf8')) as BinaryManifestEntry;
    } catch {
      problems.push('manifest is corrupt — run `kaizen setup` to re-download');
      return { available: false, problems };
    }

    if (entry.platform !== this.platformKey()) {
      problems.push(
        `manifest is for platform ${entry.platform}, this host is ${this.platformKey()} — run \`kaizen setup\``,
      );
    }
    for (const file of [entry.files?.node, entry.files?.subkey]) {
      const p = file ? path.join(this.binDir, path.basename(file)) : '';
      if (!p || !fs.existsSync(p)) {
        problems.push(`missing binary file ${file ?? '(unset)'} — run \`kaizen setup\``);
      } else if (fs.statSync(p).size < MIN_BINARY_BYTES) {
        problems.push(`binary file ${file} is implausibly small — run \`kaizen setup\``);
      }
    }

    return { available: problems.length === 0, entry, problems };
  }

  /**
   * Explicit setup: download (if needed), verify, extract, smoke-check.
   * Idempotent: a valid cached artifact is re-verified, not re-downloaded.
   */
  async setup(): Promise<BinaryManifestEntry> {
    const artifact = this.artifactFor();
    fs.mkdirSync(this.downloadDir, { recursive: true });
    fs.mkdirSync(this.binDir, { recursive: true });
    const tarballPath = path.join(this.downloadDir, path.basename(new URL(artifact.url).pathname));

    // 1. valid cache? re-verify hash + binaries, then smoke-check execution.
    if (fs.existsSync(tarballPath) && fs.existsSync(this.manifestPath)) {
      try {
        const entry = JSON.parse(
          fs.readFileSync(this.manifestPath, 'utf8'),
        ) as BinaryManifestEntry;
        const cachedHash = await sha256File(tarballPath);
        if (
          entry.platform === this.platformKey() &&
          entry.sha256 === cachedHash &&
          fs.existsSync(this.nodePath())
        ) {
          entry.binaryVersion = await this.smokeCheckVersion();
          fs.writeFileSync(this.manifestPath, JSON.stringify(entry, null, 2));
          return entry;
        }
      } catch {
        // fall through to re-download
      }
    }

    // 2. download
    const { sha256, sizeBytes } = await this.download(artifact.url, tarballPath);

    // 3. extract to staging, validate layout BEFORE executing anything
    const staging = path.join(this.downloadDir, `staging-${Date.now()}`);
    fs.mkdirSync(staging, { recursive: true });
    try {
      await this.extract(tarballPath, staging);
      const nodeSrc = findFile(staging, 'portaldot_dev');
      const subkeySrc = findFile(staging, 'subkey');
      if (!nodeSrc || !subkeySrc) {
        throw new KaizenError(
          'INVALID_ARTIFACT',
          'Downloaded artifact does not contain the expected portaldot_dev and subkey binaries',
          { staging },
        );
      }
      if (fs.statSync(nodeSrc).size < MIN_BINARY_BYTES) {
        throw new KaizenError('INVALID_ARTIFACT', 'Extracted portaldot_dev is implausibly small', {
          nodeSrc,
        });
      }
      fs.copyFileSync(nodeSrc, this.nodePath());
      fs.copyFileSync(subkeySrc, this.subkeyPath());
      fs.chmodSync(this.nodePath(), 0o755);
      fs.chmodSync(this.subkeyPath(), 0o755);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }

    // 4. smoke check: the verified binary must actually run
    const binaryVersion = await this.smokeCheckVersion();

    // 5. record TOFU manifest
    const entry: BinaryManifestEntry = {
      platform: this.platformKey(),
      channel: artifact.channel,
      sourceUrl: artifact.url,
      sha256,
      sizeBytes,
      fetchedAt: new Date().toISOString(),
      binaryVersion,
      files: { node: 'portaldot_dev', subkey: 'subkey' },
    };
    fs.writeFileSync(this.manifestPath, JSON.stringify(entry, null, 2));
    return entry;
  }

  private async download(url: string, dest: string): Promise<{ sha256: string; sizeBytes: number }> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, { redirect: 'follow' });
    } catch (e) {
      throw new KaizenError(
        'DOWNLOAD_FAILED',
        `Network error downloading ${url}: ${e instanceof Error ? e.message : String(e)}`,
        { url },
      );
    }
    if (!res.ok) {
      throw new KaizenError(
        'DOWNLOAD_FAILED',
        `HTTP ${res.status} downloading Portaldot node artifact from ${url}`,
        { url, status: res.status },
      );
    }

    let buf: Buffer;
    try {
      buf = Buffer.from(await res.arrayBuffer());
    } catch (e) {
      throw new KaizenError(
        'DOWNLOAD_FAILED',
        `Failed reading artifact body from ${url}: ${e instanceof Error ? e.message : String(e)}`,
        { url },
      );
    }
    const sizeBytes = buf.byteLength;
    if (sizeBytes < MIN_ARTIFACT_BYTES) {
      throw new KaizenError(
        'INVALID_ARTIFACT',
        `Downloaded artifact is only ${sizeBytes} bytes — refusing (expected ≥ ${MIN_ARTIFACT_BYTES})`,
        { url, sizeBytes },
      );
    }
    const sha256 = createHash('sha256').update(buf).digest('hex');
    const tmp = `${dest}.part`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, dest);
    return { sha256, sizeBytes };
  }

  private async extract(tarball: string, destDir: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = this.spawnImpl('tar', ['-xzf', tarball, '-C', destDir], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('error', reject);
      child.on('exit', (code) =>
        code === 0
          ? resolve()
          : reject(
              new KaizenError('INVALID_ARTIFACT', `tar extraction failed (code ${code}): ${stderr}`, {
                tarball,
              }),
            ),
      );
    });
  }

  /** Execute the (already hash/layout-verified) binary with --version. */
  private async smokeCheckVersion(): Promise<string> {
    const version = await new Promise<string>((resolve, reject) => {
      const child = this.spawnImpl(this.nodePath(), ['--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr?.on('data', (d: Buffer) => (err += d.toString()));
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new KaizenError('INVALID_ARTIFACT', 'portaldot_dev --version timed out after 15s'));
      }, 15_000);
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new KaizenError('INVALID_ARTIFACT', `portaldot_dev failed to execute: ${e.message}`));
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0 && out.trim()) resolve(out.trim());
        else
          reject(
            new KaizenError('INVALID_ARTIFACT', `portaldot_dev --version failed (code ${code}): ${err.trim()}`),
          );
      });
    });
    if (!version.includes('portaldot')) {
      throw new KaizenError(
        'INVALID_ARTIFACT',
        `Unexpected --version output from portaldot_dev: "${version}"`,
      );
    }
    return version;
  }
}

async function sha256File(file: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/** Recursively find a file by exact name under root (top matches preferred). */
function findFile(root: string, name: string): string | undefined {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name === name) return path.join(root, entry.name);
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = findFile(path.join(root, entry.name), name);
      if (found) return found;
    }
  }
  return undefined;
}
