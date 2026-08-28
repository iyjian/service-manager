import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ChangelogEntry, ChangelogView } from '../../shared/types';

const RELEASE_PATTERN = /^## \[?([0-9]+\.[0-9]+\.[0-9]+)\]?(?:\s*-\s*(.*))?$/;
const SECTION_PATTERN = /^### (.+)$/;
const BULLET_PATTERN = /^[-*] (.*)$/;
const VERSION_PATTERN = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/;

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

function normalizeStoredVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 64 ? trimmed : null;
}

function compareChangelogVersions(left: string, right: string): number | undefined {
  const leftMatch = VERSION_PATTERN.exec(left);
  const rightMatch = VERSION_PATTERN.exec(right);
  if (!leftMatch || !rightMatch) return undefined;
  for (let index = 1; index <= 3; index += 1) {
    const leftPart = Number(leftMatch[index]);
    const rightPart = Number(rightMatch[index]);
    if (leftPart !== rightPart) return leftPart - rightPart;
  }
  return 0;
}

export function isChangelogVersionInRange(
  version: string,
  currentVersion: string,
  previousVersion: string | null,
): boolean {
  if (!previousVersion) return version === currentVersion;
  const currentAfterPrevious = compareChangelogVersions(currentVersion, previousVersion);
  if (currentAfterPrevious !== undefined && currentAfterPrevious <= 0) {
    return version === currentVersion;
  }
  const afterPrevious = compareChangelogVersions(version, previousVersion);
  const beforeCurrent = compareChangelogVersions(version, currentVersion);
  if (afterPrevious === undefined || beforeCurrent === undefined) return version === currentVersion;
  return afterPrevious > 0 && beforeCurrent <= 0;
}

function highlightedChangelogEntries(
  entries: ChangelogEntry[],
  currentVersion: string,
  previousVersion: string | null,
): ChangelogEntry[] {
  return entries.map((entry) => ({
    ...entry,
    sections: entry.sections.map((section) => ({
      ...section,
      items: [...section.items],
    })),
    ...(isChangelogVersionInRange(entry.version, currentVersion, previousVersion)
      ? { highlighted: true }
      : {}),
  }));
}

export async function buildChangelogView(
  currentVersion: string,
  seenVersion: string | null,
  previousVersion: string | null = null,
): Promise<ChangelogView> {
  if (seenVersion === currentVersion) {
    return {
      currentVersion,
      ...(previousVersion ? { previousVersion } : {}),
      shouldShow: false,
      en: [],
      zh: [],
    };
  }
  const { en, zh } = await readChangelogEntries();
  return {
    currentVersion,
    ...(previousVersion ? { previousVersion } : {}),
    shouldShow: true,
    en: highlightedChangelogEntries(en, currentVersion, previousVersion),
    zh: highlightedChangelogEntries(zh, currentVersion, previousVersion),
  };
}

export class ChangelogSeenStore {
  private seenVersion: string | null = null;
  private lastRunVersion: string | null = null;
  private previousRunVersion: string | null = null;

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const data = JSON.parse(raw) as unknown;
      if (isRecord(data)) {
        this.seenVersion = normalizeStoredVersion(data.version);
        this.lastRunVersion = normalizeStoredVersion(data.lastRunVersion) ?? this.seenVersion;
        this.previousRunVersion = normalizeStoredVersion(data.previousRunVersion);
      }
    } catch {
      // A missing or damaged file means the user has not seen a changelog yet.
      this.seenVersion = null;
      this.lastRunVersion = null;
      this.previousRunVersion = null;
    }
  }

  getSeenVersion(): string | null {
    return this.seenVersion;
  }

  getPreviousRunVersion(): string | null {
    return this.previousRunVersion;
  }

  async recordRun(version: string): Promise<void> {
    const normalized = normalizeStoredVersion(version);
    if (!normalized) return;
    const previous = this.lastRunVersion;
    if (previous === normalized) {
      if (this.seenVersion === normalized && this.previousRunVersion) {
        this.previousRunVersion = null;
        await this.save();
      }
      return;
    }
    this.previousRunVersion = previous ?? null;
    this.lastRunVersion = normalized;
    await this.save();
  }

  async markSeen(version: string): Promise<void> {
    const normalized = normalizeStoredVersion(version);
    if (!normalized) return;
    if (this.seenVersion === normalized && this.lastRunVersion && !this.previousRunVersion) {
      return;
    }
    this.seenVersion = normalized;
    this.lastRunVersion = this.lastRunVersion ?? normalized;
    if (this.lastRunVersion === normalized) {
      this.previousRunVersion = null;
    }
    await this.save();
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(
      this.filePath,
      JSON.stringify({
        version: this.seenVersion,
        lastRunVersion: this.lastRunVersion,
        previousRunVersion: this.previousRunVersion,
      }, null, 2),
      'utf8',
    );
  }
}
