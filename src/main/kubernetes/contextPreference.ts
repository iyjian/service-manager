import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * The only durable Kubernetes setting. It intentionally contains a stable,
 * renderer-safe Context selection ID and nothing that could authenticate to a
 * cluster or reveal an absolute kubeconfig path.
 */
export interface KubernetesContextPreference {
  load(): Promise<string | undefined>;
  save(selectionId: string): Promise<void>;
  clear(): Promise<void>;
}

const MAX_CONTEXT_NAME_LENGTH = 16_384;

function isSafeContextName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_CONTEXT_NAME_LENGTH;
}

export class FileKubernetesContextPreference implements KubernetesContextPreference {
  public constructor(private readonly filePath: string) {}

  public async load(): Promise<string | undefined> {
    try {
      const value: unknown = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
      }
      const selectedContext = (value as Record<string, unknown>).selectedContext;
      return isSafeContextName(selectedContext) ? selectedContext : undefined;
    } catch {
      return undefined;
    }
  }

  public async save(selectionId: string): Promise<void> {
    if (!isSafeContextName(selectionId)) {
      throw new Error('Kubernetes Context preference is invalid.');
    }
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify({ selectedContext: selectionId }), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, this.filePath);
  }

  public async clear(): Promise<void> {
    try {
      await fs.unlink(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
}
