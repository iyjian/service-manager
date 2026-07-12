import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { KubernetesContextInfo } from '../../shared/types';
import { classifyKubeconfig, type KubeconfigDocument } from './kubeconfigStore';

export interface KubeconfigContextSource {
  kubeconfigPath: string;
  contextName: string;
}

export interface KubeconfigCatalog {
  contexts: KubernetesContextInfo[];
  sources: ReadonlyMap<string, KubeconfigContextSource>;
  fingerprint: string;
}

interface CatalogFile {
  fileName: string;
  filePath: string;
  document: KubeconfigDocument;
  fingerprintValue: string;
}

interface CatalogContext {
  context: KubernetesContextInfo;
  fileName: string;
  filePath: string;
}

interface PathJoiner {
  join(...paths: string[]): string;
}

export function kubeconfigDirectoryForHome(home: string, pathApi: PathJoiner = path): string {
  return pathApi.join(home, '.kube');
}

export function toKubeconfigDocument(value: unknown): KubeconfigDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The local Kubernetes kubeconfig is invalid.');
  }
  const record = value as Partial<KubeconfigDocument>;
  if (!Array.isArray(record.contexts) || !Array.isArray(record.users) || !Array.isArray(record.clusters)) {
    throw new Error('The local Kubernetes kubeconfig is invalid.');
  }
  return value as KubeconfigDocument;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function selectionId(fileName: string, contextName: string, occurrence: number): string {
  return createHash('sha256')
    .update(JSON.stringify([fileName, contextName, occurrence]))
    .digest('hex');
}

function buildCatalog(files: CatalogFile[]): KubeconfigCatalog {
  const contexts: CatalogContext[] = [];
  const nameCounts = new Map<string, number>();

  for (const file of files) {
    const occurrences = new Map<string, number>();
    for (const classified of classifyKubeconfig(file.document)) {
      const occurrence = occurrences.get(classified.contextName) ?? 0;
      occurrences.set(classified.contextName, occurrence + 1);
      const name = selectionId(file.fileName, classified.contextName, occurrence);
      contexts.push({
        context: { ...classified, name },
        fileName: file.fileName,
        filePath: file.filePath,
      });
      nameCounts.set(classified.contextName, (nameCounts.get(classified.contextName) ?? 0) + 1);
    }
  }

  for (const entry of contexts) {
    if ((nameCounts.get(entry.context.contextName) ?? 0) > 1) {
      entry.context.displayName = `${entry.context.contextName} — ${entry.fileName}`;
    }
  }

  contexts.sort((left, right) => (
    compareText(left.context.displayName, right.context.displayName)
    || compareText(left.fileName, right.fileName)
    || compareText(left.context.contextName, right.context.contextName)
    || compareText(left.context.name, right.context.name)
  ));

  const sources = new Map<string, KubeconfigContextSource>();
  for (const entry of contexts) {
    sources.set(entry.context.name, {
      kubeconfigPath: entry.filePath,
      contextName: entry.context.contextName,
    });
  }

  const fingerprint = createHash('sha256');
  for (const file of [...files].sort((left, right) => compareText(left.fileName, right.fileName))) {
    fingerprint.update(JSON.stringify([file.fileName, file.fingerprintValue]));
  }

  return {
    contexts: contexts.map(({ context }) => ({ ...context })),
    sources,
    fingerprint: fingerprint.digest('hex'),
  };
}

export function catalogFromDocument(filePath: string, document: KubeconfigDocument): KubeconfigCatalog {
  return buildCatalog([{
    fileName: path.basename(filePath),
    filePath,
    document,
    fingerprintValue: JSON.stringify(document),
  }]);
}

export async function scanKubeconfigDirectory(directory: string): Promise<KubeconfigCatalog> {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return buildCatalog([]);
    }
    throw new Error('The local Kubernetes kubeconfig directory could not be read.');
  }

  const files: CatalogFile[] = [];
  for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
    if (!entry.isFile()) {
      continue;
    }
    const filePath = path.join(directory, entry.name);
    try {
      const contents = await fs.readFile(filePath, 'utf8');
      const document = toKubeconfigDocument(yaml.load(contents));
      // Reject malformed nested records per file rather than allowing one
      // candidate to break the complete catalog during final assembly.
      classifyKubeconfig(document);
      files.push({ fileName: entry.name, filePath, document, fingerprintValue: contents });
    } catch {
      // `.kube` commonly contains certificates and helper files. An invalid
      // or concurrently removed candidate must not block valid kubeconfigs.
    }
  }
  return buildCatalog(files);
}

export function resolveKubeconfigContext(
  catalog: KubeconfigCatalog,
  selectionIdValue: string
): KubeconfigContextSource | undefined {
  const source = catalog.sources.get(selectionIdValue);
  return source ? { ...source } : undefined;
}
