# Proxy Running Intent Auto-Start Design

## Goal

Remember whether the user wants the local Mihomo proxy to remain running. When Service Manager opens again, automatically start Mihomo if the previous successful user intent was running, and otherwise keep it stopped.

The persisted value represents desired running intent, not the instantaneous child-process state during shutdown.

## User-Visible Behavior

- A successful Proxy Start enables startup restoration.
- An explicit Proxy Stop disables startup restoration.
- Closing Service Manager stops the local Mihomo child for process cleanup but does not disable startup restoration.
- An unexpected Mihomo exit does not disable startup restoration.
- On the next application launch, enabled startup restoration starts Mihomo through the ordinary startup path.
- Auto-start failure leaves Service Manager open, exposes the Proxy error state, records the main-process error, retains the enabled intent, and retries on a later application launch.
- Existing users default to disabled startup restoration until they successfully start Proxy again.
- No new UI toggle is added; Start and Stop express the user's intent.

## Persisted Model

Add the following field to `ProxySettings`:

```ts
startOnLaunch: boolean;
```

`DEFAULT_SETTINGS` sets it to `false`. Persisted settings sanitization accepts only the literal boolean `true`; missing, false, malformed, or legacy values become `false`.

The field remains part of `proxy-config.json` and the existing `ProxyState.settings` snapshot. No second marker file or migration file is introduced.

## Intent Mutation Rules

`ProxyRuntime` will centralize intent updates in one persistence helper that restores the previous in-memory value when writing settings fails.

### Successful Start

The ordinary `start()` flow continues to validate the installed core, load the parsed subscription cache with raw-YAML fallback, create the runtime config, launch Mihomo, wait for the controller, restore valid manual selections, and activate System Proxy when configured.

Only after all required startup work succeeds does `start()` persist `startOnLaunch: true`. If this persistence fails, startup is treated as unsuccessful: the child is torn down by the existing start error path, the previous intent is restored in memory, and the error is surfaced.

If the persisted intent is already true, startup does not need an extra settings write.

### Explicit Stop

`stop()` persists `startOnLaunch: false` before beginning teardown. If persistence fails, Stop rejects before terminating the child so the visible runtime and persisted intent do not contradict each other.

Calling Stop while already stopped still clears a previously enabled intent. This lets the user cancel future auto-start after an unexpected exit or failed automatic restoration.

After the intent is disabled, the existing stop flow deactivates System Proxy, terminates Mihomo, and settles to stopped.

### Shutdown and Unexpected Exit

`shutdown()` remains cleanup-only: it deactivates System Proxy and terminates the child without changing `startOnLaunch`.

The child `exit` handler continues to report an unexpected exit as an error and does not change the persisted intent.

Internal restarts caused by settings changes remain running-intent preserving. They use the ordinary start path while the intent is already true.

Start, explicit Stop, internal restart, shutdown, and complete System Proxy mutations are serialized through one lifecycle queue. A Stop or shutdown requested during startup or OS proxy activation waits for that in-flight lifecycle action and then runs, so the later user/cleanup action remains authoritative. Settings-file writes use a separate invocation-order queue, and an internal settings restart rechecks the current running state and intent before teardown so a later Stop cannot be undone. The Proxy toggle routes both `starting` and `running` states to Stop.

Port changes restore System Proxy only when the internal restart leaves Proxy running with enabled intent. Save & Fetch commits only its subscription count and refresh timestamp into the current settings object; it never restores a full settings snapshot that could overwrite a concurrent explicit Stop.

## Application Startup Orchestration

Add a `ProxyRuntime` method that reads the sanitized intent and either returns the current snapshot or calls the ordinary `start()` method.

In `main.ts`, invoke this restoration asynchronously after IPC handlers, Proxy state broadcasting, and the BrowserWindow are initialized. Auto-start must not delay or abort creation of the main window.

The asynchronous rejection is logged through the existing main-process runtime-error path. The ordinary Proxy state transition broadcasts `starting`, `running`, or `error` to the renderer. If the renderer subscribes after an early transition, its initial `proxy:get-state` request still returns the current state.

## Failure Semantics

- Missing core, missing/invalid subscription cache, runtime-config failure, spawn failure, controller timeout, selection failure outside the existing tolerated cases, System Proxy activation failure, or intent-persistence failure follows the existing start error path.
- Missing-core and child-process `error` events settle to renderer-visible Proxy error state. Spawn errors are raced against controller startup and are handled without reaching the process-level uncaught exception path.
- A failed manual Start from disabled intent remains disabled.
- A failed automatic Start from enabled intent remains enabled for a later launch retry.
- A failed intent write during explicit Stop leaves Mihomo running and reports the persistence error.
- Startup restoration errors do not show the application-level fatal startup dialog and do not quit Service Manager.

## Testing

Use Node's built-in test runner against compiled `dist` output.

Coverage will include:

- missing and malformed persisted fields sanitize to false;
- a valid persisted true value is retained;
- enabling and disabling intent persists transactionally;
- Stop clears enabled intent even when the runtime is already stopped;
- shutdown leaves enabled intent unchanged;
- failed persistence restores the prior in-memory intent;
- automatic restoration is a no-op when disabled and delegates to ordinary Start when enabled;
- main-process startup calls restoration non-blockingly and logs failure rather than rejecting application initialization;
- concurrent Start/Stop and Start/shutdown calls preserve invocation order and leave the later Stop/shutdown authoritative;
- concurrent settings writes preserve invocation order, and a later Stop prevents a pending settings restart from starting Mihomo again;
- a concurrent Stop prevents a pending port-change restart from reactivating System Proxy;
- a concurrent Stop waits behind an in-flight System Proxy activation and disables it during teardown;
- Save & Fetch preserves running intent changed by a concurrent explicit Stop;
- missing-core and injected child spawn failures produce Proxy error state without enabling startup intent;
- successful public Start persists enabled intent, while an intent write failure tears down the child and restores disabled intent;
- existing subscription, System Proxy, TUN, selection, and restart tests remain green.

The full `pnpm test` workflow must pass.

## Documentation

Update `README.md` and `AGENTS.md` to describe the desired-running-state model, successful-Start/explicit-Stop persistence rules, cleanup-only shutdown, non-blocking startup restoration, and retry behavior after auto-start failure or an unexpected Mihomo exit.
