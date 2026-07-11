# Proxy Subscription Strategy-Group Selection

## Goal

Expose the subscription's manually selectable Mihomo strategy groups so users can independently choose policies such as `全球直连` and `漏网之鱼`. The current proxy page only exposes one inferred primary group, even though the subscription's remaining groups and rules are preserved and active.

## Scope

- Show only runtime Mihomo groups whose type is `Selector`.
- Display each group name, current selection, and every runtime candidate supplied by that group.
- Candidates may be a concrete node, `DIRECT`, `REJECT`, or another strategy group.
- Persist a selection per group and restore each valid saved selection after the core starts.
- Keep automatic groups, including URL-test, fallback, load-balance, and relay groups, out of the interactive UI.

## Runtime Data Flow

1. After the proxy is running, request Mihomo's `/proxies` endpoint.
2. Filter entries to manual `Selector` groups, excluding Mihomo's synthetic `GLOBAL` entry.
3. For each group, map `all` candidates to a small renderer contract using the runtime record for name, type, and latest latency when available.
4. The renderer displays one compact section per group. Choosing a candidate invokes a new IPC operation with both the group and candidate names.
5. The main process calls Mihomo's group-selection endpoint, records the choice in settings, emits state, and the renderer refreshes group data.

## Persistence and Compatibility

`ProxySettings` gains a `selectedProxies` map keyed by group name. On startup, the runtime reapplies every saved group choice after the controller is reachable. Missing groups or removed candidates are skipped without failing startup.

The existing single `selectedProxy` value remains readable for compatibility. When it is present and the map has no entry for the inferred primary group, it is treated as that primary group's saved value. New writes use only the group-keyed map.

## UI Behavior

- Rename the current Nodes card to Strategy Groups.
- Render no interactive groups while the proxy is stopped.
- Keep the existing refresh control and make it refresh all visible manual groups.
- A group header shows its name and current candidate; its candidates appear as the existing compact selectable rows.
- Dynamic names and types continue to be escaped before HTML injection.

## Testing

- Cover filtering of runtime proxy records to manual selector groups only.
- Cover nested group and special candidates (`DIRECT` and `REJECT`).
- Cover group-keyed saved selections being reapplied and invalid entries being skipped.
- Cover compatibility migration from the legacy primary-group selection.
- Run `pnpm test`, which builds TypeScript then executes the Node tests against `dist`.

## Non-Goals

- Editing subscription YAML, rules, or groups.
- Displaying automatic or read-only groups as manually selectable controls.
- Adding delay testing, proxy-provider management, or Clash Verge Rev's advanced group-navigation UI.
