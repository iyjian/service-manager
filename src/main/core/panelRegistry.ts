import type { PanelDefinition } from '../../shared/types';

/** Trusted application catalog. Add future panels here; window IPC never accepts renderer registrations. */
export const PANEL_DEFINITIONS: readonly PanelDefinition[] = Object.freeze([
  { id: 'hosts', title: 'Hosts', icon: 'server' },
  { id: 'proxy', title: 'Proxy', icon: 'globe' },
  { id: 'kubernetes', title: 'Kubernetes', icon: 'boxes' },
  { id: 'sql', title: 'SQL', icon: 'database' },
  { id: 'notes', title: 'Notes', icon: 'notebook-pen' },
]);

export class PanelRegistry {
  private readonly entries: ReadonlyMap<string, PanelDefinition>;
  readonly defaultId: string;
  constructor(definitions: readonly PanelDefinition[] = PANEL_DEFINITIONS) {
    const entries = new Map<string, PanelDefinition>();
    for (const definition of definitions) {
      if (!/^[a-z][a-z0-9-]*$/.test(definition.id) || !definition.title.trim() || entries.has(definition.id)) {
        throw new Error('Invalid or duplicate panel definition.');
      }
      entries.set(definition.id, Object.freeze({ ...definition }));
    }
    if (!entries.size) throw new Error('At least one panel is required.');
    this.entries = entries;
    this.defaultId = definitions[0].id;
  }
  validate(value: unknown): string {
    if (typeof value !== 'string' || !this.entries.has(value)) throw new Error('Unknown panel.');
    return value;
  }
  title(id: string): string { return this.entries.get(this.validate(id))!.title; }
  list(): PanelDefinition[] { return [...this.entries.values()]; }
}
