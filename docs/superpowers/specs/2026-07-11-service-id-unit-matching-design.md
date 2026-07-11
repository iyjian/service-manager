# Service ID Unit Matching Design

## Goal

Allow a configured service to recognize and manage its existing remote `systemd --user` transient unit when the configured Host ID has changed but the Service ID is unchanged.

Service Manager will treat an app-generated canonical UUID Service ID as the remote service identity. Host ID remains part of the stored host record and the conventional unit name, but it will not participate in matching an existing canonical UUID unit. Arbitrary imported IDs retain exact conventional-name matching because the legacy hyphen-delimited name cannot encode them unambiguously.

## Current Problem

The current runtime constructs one exact unit name for every operation:

```text
service-manager-{hostId}-{serviceId}.service
```

Status, start, stop, and log operations therefore report a service as stopped when the remote unit was created from the same Service ID under an older Host ID. The service cannot be managed from the current configuration even though its Service ID is unchanged.

## Scope

This change covers all remote service lifecycle paths:

- status refresh;
- start and post-start PID polling;
- stop and post-stop polling;
- journal log lookup.

It does not change:

- persisted Host IDs or Service IDs;
- Service ID generation;
- the conventional name used when creating a unit for which no existing match is found;
- SSH endpoint scoping;
- forwarding-rule identity;
- existing remote units through rename, migration, or deletion.

## Unit Resolution

Resolution happens only within the current host's SSH connection and remote user-level systemd manager. Units belonging to another machine or remote account are outside the lookup scope.

For a configured canonical UUID Service ID, the runtime lists loaded user service units matching the Service Manager namespace and parses candidates only when the complete name has two canonical UUID fields:

```text
service-manager-{hostUuid}-{serviceUuid}.service
```

The parsed Service UUID must exactly equal the configured Service ID. The parsed Host UUID is not compared with the configured Host ID. This fixed-width shape prevents `bar` from claiming a unit whose arbitrary Service ID is `foo-bar`, and prevents aliases introduced by unit-fragment sanitization.

For a non-UUID imported Service ID, the runtime accepts only the exact unit name produced from the current Host ID and Service ID. Cross-Host discovery is intentionally unavailable for those legacy identities until a future unambiguous unit format exists.

Resolution produces one of three outcomes:

1. No matching unit: use `service-manager-{currentHostId}-{serviceId}.service` as the name for a possible new unit and treat its current state as missing.
2. Exactly one matching unit: use that unit's full remote name for every lifecycle and log operation.
3. More than one matching unit: return an explicit ambiguity error and do not start, stop, or otherwise mutate any candidate.

The ambiguity branch protects against copied or manually edited configuration even though randomly generated UUID collisions are negligible.

## Lifecycle Data Flow

The runtime will separate unit resolution from unit state inspection:

1. Validate remote systemd support.
2. Resolve the unit by Service ID.
3. Query `systemctl --user show` using the resolved full unit name.
4. Pin that unit name for the complete operation, including polling loops.

Pinning prevents a start or stop operation from changing targets between its initial command and later state polls.

### Status

Status resolves the unit, inspects it, and maps the systemd state to the existing Service Manager status model. A missing match remains `stopped`.

### Start

Start resolves first. If a matching unit is active or activating, it returns the existing "already managed" result. If one inactive or failed match exists, start reuses that resolved unit name. If no match exists, start creates the conventional current Host ID plus Service ID unit name.

The pre-start stop/reset, `systemd-run`, and MainPID polling all use the same pinned unit name.

### Stop

Stop resolves first and operates on the one matched unit. Missing or inactive units remain a successful no-op. Stop polling and failed-state reset use the same pinned name.

### Logs

Log lookup resolves the unit and reads the current invocation when `InvocationID` is available. Its existing unit-name fallback uses the resolved remote unit name rather than a name reconstructed from the current Host ID.

## Error Handling

Existing SSH and systemd setup errors remain unchanged. Discovery-command failures are surfaced as runtime errors through the existing page-toast paths.

An ambiguity error identifies the Service ID and candidate unit names so the operator can inspect the remote user manager. No candidate is automatically preferred by activity state or Host ID.

Dynamic unit names and discovery patterns continue to use the existing shell-quoting and unit-fragment sanitization helpers.

## Code Structure

`src/main/serviceRuntime.ts` will gain small pure helpers for:

- recognizing the complete canonical Host UUID plus Service UUID unit shape;
- parsing unit names returned by systemd;
- selecting zero, one, or ambiguous candidates.

Lifecycle helpers will accept an already resolved unit name instead of reconstructing it internally. No new dependency or persistence field is required.

## Testing

Node built-in tests will cover:

- matching the same Service ID under a different Host ID;
- rejecting similar but non-identical Service ID suffixes;
- rejecting suffix aliases from arbitrary imported IDs and noncanonical candidate names;
- no-match fallback to the current conventional name;
- ambiguity detection;
- unit-name sanitization;
- command construction using the resolved unit where practical.

The full `pnpm test` workflow must pass after implementation.

## Documentation

`README.md` and `AGENTS.md` will state that remote service ownership is resolved by Service ID within the target SSH account, while Host ID remains only a conventional unit-name component for newly created units.
