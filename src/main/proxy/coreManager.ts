import { promises as fs } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import AdmZip from 'adm-zip';

const execFileAsync = promisify(execFile);

const MIHOMO_RELEASES_API = 'https://api.github.com/repos/MetaCubeX/mihomo/releases/latest';

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface CoreInstallInfo {
  version: string;
  binaryPath: string;
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
  constructor(private readonly coreDir: string) {}

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
    const releaseResponse = await fetch(MIHOMO_RELEASES_API, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'service-manager' },
    });
    if (!releaseResponse.ok) {
      throw new Error(`Failed to query mihomo releases (HTTP ${releaseResponse.status}).`);
    }
    const release = (await releaseResponse.json()) as { tag_name?: string; assets?: ReleaseAsset[] };
    const asset = selectCoreAsset(release.assets ?? []);
    if (!asset) {
      throw new Error(`No mihomo build found for ${corePlatform()}-${coreArch()}.`);
    }

    await fs.mkdir(this.coreDir, { recursive: true });
    const archivePath = path.join(this.coreDir, asset.name);
    await this.downloadFile(asset.browser_download_url, archivePath, onProgress);

    try {
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
      await fs.rm(archivePath, { force: true });
    }

    if (process.platform !== 'win32') {
      await fs.chmod(this.binaryPath, 0o755);
    }

    const version = await this.probeVersion(release.tag_name ?? 'unknown');
    await fs.writeFile(this.versionFilePath, JSON.stringify({ version }, null, 2), 'utf8');
    return { version, binaryPath: this.binaryPath };
  }

  private async downloadFile(url: string, destination: string, onProgress?: (percent: number) => void): Promise<void> {
    const response = await fetch(url, { headers: { 'user-agent': 'service-manager' } });
    if (!response.ok || !response.body) {
      throw new Error(`Failed to download mihomo core (HTTP ${response.status}).`);
    }

    const total = Number(response.headers.get('content-length') ?? 0);
    let received = 0;
    const reader = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
    const fileHandle = await fs.open(destination, 'w');
    try {
      for await (const chunk of reader) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        await fileHandle.write(buffer);
        received += buffer.length;
        if (total > 0) {
          onProgress?.(Math.min(99, Math.round((received / total) * 100)));
        }
      }
    } finally {
      await fileHandle.close();
    }
    onProgress?.(100);
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
