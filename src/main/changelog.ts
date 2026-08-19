import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ChangelogEntry, ChangelogView } from '../shared/types';

const RELEASE_PATTERN = /^## \[?([0-9]+\.[0-9]+\.[0-9]+)\]?(?:\s*-\s*(.*))?$/;
const SECTION_PATTERN = /^### (.+)$/;
const BULLET_PATTERN = /^[-*] (.*)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function changelogFilePath(fileName: string): string {
  const base = app.isPackaged ? path.join(app.getAppPath(), 'dist') : app.getAppPath();
  return path.join(base, fileName);
}

export function parseChangelog(markdown: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  let current: ChangelogEntry | null = null;
  let currentSection: { title: string; items: string[] } | null = null;

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();

    const release = line.match(RELEASE_PATTERN);
    if (release) {
      current = {
        version: release[1],
        date: release[2]?.trim() || undefined,
        sections: [],
      };
      currentSection = null;
      entries.push(current);
      continue;
    }

    const section = line.match(SECTION_PATTERN);
    if (section) {
      if (!current) continue;
      currentSection = { title: section[1].trim(), items: [] };
      current.sections.push(currentSection);
      continue;
    }

    const bullet = line.match(BULLET_PATTERN);
    if (bullet) {
      if (!current || !currentSection) continue;
      currentSection.items.push(bullet[1].trim());
    }
  }

  return entries;
}

let cachedEntries: { en: ChangelogEntry[]; zh: ChangelogEntry[] } | null = null;

async function readChangelogEntries(): Promise<{ en: ChangelogEntry[]; zh: ChangelogEntry[] }> {
  if (cachedEntries) {
    return cachedEntries;
  }
  const [en, zh] = await Promise.all([
    fs.readFile(changelogFilePath('CHANGELOG.md'), 'utf8'),
    fs.readFile(changelogFilePath('CHANGELOG.zh.md'), 'utf8'),
  ]);
  cachedEntries = { en: parseChangelog(en), zh: parseChangelog(zh) };
  return cachedEntries;
}

export async function buildChangelogView(
  currentVersion: string,
  seenVersion: string | null,
): Promise<ChangelogView> {
  if (seenVersion === currentVersion) {
    return { currentVersion, shouldShow: false, en: [], zh: [] };
  }
  const { en, zh } = await readChangelogEntries();
  return { currentVersion, shouldShow: true, en, zh };
}

export class ChangelogSeenStore {
  private seenVersion: string | null = null;

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const data = JSON.parse(raw) as unknown;
      if (isRecord(data) && typeof data.version === 'string') {
        this.seenVersion = data.version;
      }
    } catch {
      // A missing or damaged file means the user has not seen a changelog yet.
      this.seenVersion = null;
    }
  }

  getSeenVersion(): string | null {
    return this.seenVersion;
  }

  async markSeen(version: string): Promise<void> {
    if (this.seenVersion === version) {
      return;
    }
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify({ version }, null, 2), 'utf8');
    this.seenVersion = version;
  }
}
