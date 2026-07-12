import { promises as fs } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import AdmZip from 'adm-zip';

const execFileAsync = promisify(execFile);

const MIHOMO_RELEASES_API = 'https://api.github.com/repos/MetaCubeX/mihomo/releases/latest';
const DOWNLOAD_MIRROR_PREFIXES = ['https://update.hwdns.net/', 'https://gh-proxy.org/', ''] as const;
const SHA256_DIGEST = /^sha256:([a-f0-9]{64})$/i;

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  digest?: string;
}

export interface CoreInstallInfo {
  version: string;
  binaryPath: string;
}

interface MihomoRelease {
  tag_name?: string;
  assets: ReleaseAsset[];
}

class LocalArchiveWriteError extends Error {
  readonly cause: unknown;

  constructor(error: unknown) {
    super(`Unable to write Mihomo archive: ${error instanceof Error ? error.message : String(error)}`);
    this.name = 'LocalArchiveWriteError';
    this.cause = error;
  }
}

export function downloadSourceCandidates(officialUrl: string): string[] {
  return DOWNLOAD_MIRROR_PREFIXES.map((prefix) => `${prefix}${officialUrl}`);
}

export function parseSha256Digest(value: string | undefined): string | null {
  return SHA256_DIGEST.exec(value ?? '')?.[1].toLowerCase() ?? null;
}

export function coreBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'mihomo.exe' : 'mihomo';
}

export function coreArch(arch: string = process.arch): string {
  if (arch === 'x64') return 'amd64';
  if (arch === 'ia32') return '386';
  return arch;
}

export function corePlatform(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return 'windows';
  return platform;
}

export function selectCoreAsset(
  assets: ReleaseAsset[],
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): ReleaseAsset | null {
  const wantPlatform = corePlatform(platform);
  const wantArch = coreArch(arch);
  const extension = platform === 'win32' ? '.zip' : '.gz';
  const prefix = `mihomo-${wantPlatform}-${wantArch}-`;

  const candidates = assets.filter(
    (asset) =>
      asset.name.startsWith(prefix) &&
      asset.name.endsWith(extension) &&
      // Skip variant builds like amd64-compatible / arm64-cgo: the segment
      // right after the arch must be the version (v...).
      asset.name.slice(prefix.length).startsWith('v')
  );

  return candidates[0] ?? null;
}

export class CoreManager {
  constructor(
    private readonly coreDir: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  get binaryPath(): string {
    return path.join(this.coreDir, coreBinaryName());
  }

  private get versionFilePath(): string {
    return path.join(this.coreDir, 'version.json');
  }

  async getInstalledInfo(): Promise<CoreInstallInfo | null> {
    try {
      await fs.access(this.binaryPath);
      const raw = await fs.readFile(this.versionFilePath, 'utf8');
      const data = JSON.parse(raw) as { version?: string };
      return { version: data.version ?? 'unknown', binaryPath: this.binaryPath };
    } catch {
      return null;
    }
  }

  async download(onProgress?: (percent: number) => void): Promise<CoreInstallInfo> {
    const release = await this.fetchRelease();
    const asset = selectCoreAsset(release.assets);
    if (!asset) {
      throw new Error(`No mihomo build found for ${corePlatform()}-${coreArch()}.`);
    }
    const expectedDigest = parseSha256Digest(asset.digest);
    if (!expectedDigest) {
      throw new Error(`Mihomo release asset ${asset.name} does not provide a valid SHA-256 digest.`);
    }

    await fs.mkdir(this.coreDir, { recursive: true });
    const archivePath = path.join(this.coreDir, asset.name);

    try {
      await this.downloadVerifiedArchive(asset.browser_download_url, archivePath, expectedDigest, onProgress);
      if (asset.name.endsWith('.zip')) {
        const zip = new AdmZip(archivePath);
        const entry = zip
          .getEntries()
          .find((item) => path.basename(item.entryName).startsWith('mihomo') && !item.isDirectory);
        if (!entry) {
          throw new Error('mihomo binary not found inside the downloaded zip.');
        }
        await fs.writeFile(this.binaryPath, entry.getData());
      } else {
        const compressed = await fs.readFile(archivePath);
        // fetch may transparently gunzip .gz assets when the CDN marks them
        // with content-encoding; only gunzip when the gzip magic is present.
        const isGzip = compressed.length > 2 && compressed[0] === 0x1f && compressed[1] === 0x8b;
        await fs.writeFile(this.binaryPath, isGzip ? zlib.gunzipSync(compressed) : compressed);
      }
    } finally {
      await this.removeArchive(archivePath);
    }

    if (process.platform !== 'win32') {
      await fs.chmod(this.binaryPath, 0o755);
    }

    const version = await this.probeVersion(release.tag_name ?? 'unknown');
    await fs.writeFile(this.versionFilePath, JSON.stringify({ version }, null, 2), 'utf8');
    return { version, binaryPath: this.binaryPath };
  }

  private async fetchRelease(): Promise<MihomoRelease> {
    const sources = downloadSourceCandidates(MIHOMO_RELEASES_API);
    for (const source of sources) {
      try {
        const response = await this.fetchImpl(source, {
          headers: { accept: 'application/vnd.github+json', 'user-agent': 'service-manager' },
        });
        if (!response.ok) {
          continue;
        }
        const release = await response.json();
        if (isMihomoRelease(release)) {
          return release;
        }
      } catch {
        // Try the next user-approved distribution endpoint.
      }
    }
    throw new Error(`Failed to query mihomo releases. Tried: ${sources.join(', ')}.`);
  }

  private async downloadVerifiedArchive(
    officialUrl: string,
    destination: string,
    expectedDigest: string,
    onProgress?: (percent: number) => void
  ): Promise<void> {
    const sources = downloadSourceCandidates(officialUrl);
    for (const source of sources) {
      await this.removeArchive(destination);
      try {
        await this.downloadFile(source, destination, expectedDigest, onProgress);
        return;
      } catch (error) {
        try {
          await this.removeArchive(destination);
        } catch (cleanupError) {
          throw cleanupError;
        }
        if (error instanceof LocalArchiveWriteError) {
          throw error;
        }
      }
    }
    throw new Error(
      `Mihomo archive checksum verification failed or download was unavailable. Tried: ${sources.join(', ')}.`
    );
  }

  private async downloadFile(
    url: string,
    destination: string,
    expectedDigest: string,
    onProgress?: (percent: number) => void
  ): Promise<void> {
    const response = await this.fetchImpl(url, { headers: { 'user-agent': 'service-manager' } });
    if (!response.ok || !response.body) {
      throw new Error(`Failed to download mihomo core (HTTP ${response.status}).`);
    }

    const total = Number(response.headers.get('content-length') ?? 0);
    let received = 0;
    const hash = createHash('sha256');
    const reader = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
    let fileHandle: Awaited<ReturnType<typeof fs.open>>;
    try {
      fileHandle = await fs.open(destination, 'w');
    } catch (error) {
      throw new LocalArchiveWriteError(error);
    }
    try {
      for await (const chunk of reader) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        try {
          await fileHandle.write(buffer);
        } catch (error) {
          throw new LocalArchiveWriteError(error);
        }
        hash.update(buffer);
        received += buffer.length;
        if (total > 0) {
          onProgress?.(Math.min(99, Math.round((received / total) * 100)));
        }
      }
    } finally {
      try {
        await fileHandle.close();
      } catch (error) {
        throw new LocalArchiveWriteError(error);
      }
    }

    if (hash.digest('hex') !== expectedDigest) {
      throw new Error('Mihomo archive checksum verification failed.');
    }
    onProgress?.(100);
  }

  private async removeArchive(destination: string): Promise<void> {
    try {
      await fs.rm(destination, { force: true });
    } catch (error) {
      throw new LocalArchiveWriteError(error);
    }
  }

  private async probeVersion(fallback: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync(this.binaryPath, ['-v'], { timeout: 5000 });
      // Example: "Mihomo Meta v1.19.2 darwin arm64 ..."
      const match = stdout.match(/v\d+\.\d+\.\d+/);
      return match ? match[0] : fallback;
    } catch {
      return fallback;
    }
  }
}

function isMihomoRelease(value: unknown): value is MihomoRelease {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const release = value as { tag_name?: unknown; assets?: unknown };
  return (
    (release.tag_name === undefined || typeof release.tag_name === 'string') &&
    Array.isArray(release.assets) &&
    release.assets.every(isReleaseAsset)
  );
}

function isReleaseAsset(value: unknown): value is ReleaseAsset {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const asset = value as { name?: unknown; browser_download_url?: unknown; digest?: unknown };
  return (
    typeof asset.name === 'string' &&
    typeof asset.browser_download_url === 'string' &&
    (asset.digest === undefined || typeof asset.digest === 'string')
  );
}
