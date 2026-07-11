import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type {
  ProxyGroupsInfo,
  ProxyExceptionDraft,
  ProxyCustomRule,
  ProxyCustomRuleDraft,
  ProxyMode,
  ProxyRunStatus,
  ProxySettings,
  ProxyState,
  ProxyTunSupport,
} from '../../shared/types';
import { CoreManager } from './coreManager';
import {
  buildRuntimeConfig,
  dumpRuntimeConfig,
  parseSubscription,
  type SubscriptionInfo,
} from './configBuilder';
import { parseSubscriptionCache, serializeSubscriptionCache } from './subscriptionCache';
import { MihomoApi } from './mihomoApi';
import {
  findManualProxyOption,
  listManualProxyGroups,
  normalizeSavedProxySelections,
  validSavedProxySelections,
} from './proxyGroups';
import { normalizeProxyCustomRules } from './proxyExceptions';
import { applySystemProxy, readSystemProxy } from './systemProxy';
import { checkTunSupport, grantTunPermission, revokeTunPermission } from './tunPermission';

const MAX_LOG_LINES = 2000;
const CONTROLLER_STARTUP_TIMEOUT_MS = 12000;

const DEFAULT_SETTINGS: ProxySettings = {
  startOnLaunch: false,
  mode: 'rule',
  mixedPort: 7890,
  tunEnabled: false,
  systemProxyEnabled: false,
  customRules: [],
};

function sanitizePersistedCustomRules(value: unknown): ProxyCustomRule[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((rule) => {
    try {
      return normalizeProxyCustomRules([rule as ProxyCustomRuleDraft]);
    } catch {
      return [];
    }
  });
}

function sanitizePersistedLegacyExceptions(value: unknown): ProxyCustomRule[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((exception) => {
    if (typeof exception !== 'object' || exception === null || Array.isArray(exception)) {
      return [];
    }

    try {
      const { target: _legacyTarget, ...legacyRule } = exception as ProxyCustomRuleDraft;
      return normalizeProxyCustomRules([legacyRule]);
    } catch {
      return [];
    }
  });
}

function sanitizePersistedSettings(value: unknown): ProxySettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ...DEFAULT_SETTINGS, customRules: [] };
  }

  const persisted = value as Partial<ProxySettings> & { subscriptionUrl?: unknown };
  const {
    subscriptionUrl: _legacySubscriptionUrl,
    exceptions: legacyExceptions,
    customRules,
    startOnLaunch,
    ...persistedWithoutLegacyFields
  } = persisted;
  return {
    ...DEFAULT_SETTINGS,
    ...persistedWithoutLegacyFields,
    startOnLaunch: startOnLaunch === true,
    customRules: Array.isArray(customRules)
      ? sanitizePersistedCustomRules(customRules)
      : sanitizePersistedLegacyExceptions(legacyExceptions),
  };
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') {
          resolve(address.port);
        } else {
          reject(new Error('Unable to allocate a controller port.'));
        }
      });
    });
  });
}

export class ProxyRuntime extends EventEmitter {
  private readonly coreManager: CoreManager;
  private settings: ProxySettings = { ...DEFAULT_SETTINGS };
  private runStatus: ProxyRunStatus = 'stopped';
  private lastError: string | undefined;
  private coreVersion: string | undefined;
  private downloadProgress: number | undefined;
  private isDownloading = false;
  private child: ChildProcess | null = null;
  private api: MihomoApi | null = null;
  private logLines: string[] = [];
  private systemProxyActive = false;
  private expectingExit = false;
  private tunSupport: ProxyTunSupport | undefined;
  private lifecycleQueue: Promise<void> = Promise.resolve();
  private settingsWriteQueue: Promise<void> = Promise.resolve();
  constructor(
    private readonly proxyDir: string,
    private readonly spawnProcess: typeof spawn = spawn,
    private readonly getControllerPort: () => Promise<number> = getFreePort
  ) {
    super();
    this.coreManager = new CoreManager(path.join(proxyDir, 'core'));
  }

  private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleQueue.then(operation);
    this.lifecycleQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private get settingsPath(): string {
    return path.join(this.proxyDir, 'proxy-config.json');
  }

  private get subscriptionCachePath(): string {
    return path.join(this.proxyDir, 'subscription.yaml');
  }

  private get parsedSubscriptionCachePath(): string {
    return path.join(this.proxyDir, 'subscription.parsed.json');
  }

  private get runtimeConfigPath(): string {
    return path.join(this.proxyDir, 'runtime.yaml');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.proxyDir, { recursive: true });
    try {
      const raw = await fs.readFile(this.settingsPath, 'utf8');
      this.settings = sanitizePersistedSettings(JSON.parse(raw));
    } catch {
      this.settings = { ...DEFAULT_SETTINGS, customRules: [] };
    }
    const installed = await this.coreManager.getInstalledInfo();
    this.coreVersion = installed?.version;
    await this.refreshTunSupport();

    // Mirror clash-verge-rev: if TUN is enabled but no longer available
    // (e.g. the core was re-downloaded and lost its privileges), disable it.
    if (this.settings.tunEnabled && !this.tunSupport?.available) {
      this.settings.tunEnabled = false;
      await this.persistSettings();
    }

    // If the app was killed while the system proxy pointed at us, the OS is
    // left with a dead proxy (no listener) and the whole system loses network.
    // Clear the stale entry; start() re-applies it when the proxy comes up.
    if (this.settings.systemProxyEnabled) {
      try {
        const current = await readSystemProxy();
        if (current?.enabled && current.host === '127.0.0.1' && current.port === this.settings.mixedPort) {
          await applySystemProxy(false, this.settings.mixedPort);
        }
      } catch {
        // Best effort; never block startup on proxy cleanup.
      }
    }
  }

  private async refreshTunSupport(): Promise<void> {
    this.tunSupport = await checkTunSupport(this.coreManager.binaryPath);
  }

  async getState(): Promise<ProxyState> {
    return this.snapshot();
  }

  getLogs(): string {
    return this.logLines.join('\n');
  }

  private currentCustomRules(): ProxyCustomRule[] {
    const customRules = sanitizePersistedCustomRules(this.settings.customRules);
    this.settings.customRules = customRules;
    return customRules;
  }

  private snapshot(): ProxyState {
    const customRules = this.currentCustomRules();
    const settings: ProxySettings = {
      ...this.settings,
      ...(this.settings.selectedProxies ? { selectedProxies: { ...this.settings.selectedProxies } } : {}),
      customRules: customRules.map((rule) => ({ ...rule })),
    };

    return {
      core: {
        status: this.isDownloading ? 'downloading' : this.coreVersion ? 'installed' : 'not-installed',
        version: this.coreVersion,
        downloadProgress: this.isDownloading ? this.downloadProgress : undefined,
      },
      running: this.runStatus,
      pid: this.child?.pid,
      error: this.lastError,
      settings,
      tunSupport: this.tunSupport ? { ...this.tunSupport } : undefined,
    };
  }

  private emitState(): void {
    this.emit('state-changed', this.snapshot());
  }

  private setRunStatus(status: ProxyRunStatus, error?: string): void {
    this.runStatus = status;
    this.lastError = error;
    this.emitState();
  }

  private appendLog(chunk: string): void {
    const lines = chunk.split('\n').filter((line) => line.trim().length > 0);
    if (lines.length === 0) return;
    this.logLines.push(...lines);
    if (this.logLines.length > MAX_LOG_LINES) {
      this.logLines = this.logLines.slice(-MAX_LOG_LINES);
    }
  }

  private async persistSettingsNow(): Promise<void> {
    await fs.mkdir(this.proxyDir, { recursive: true });
    await fs.writeFile(this.settingsPath, JSON.stringify(this.settings, null, 2), 'utf8');
  }

  private persistSettings(): Promise<void> {
    const result = this.settingsWriteQueue.then(() => this.persistSettingsNow());
    this.settingsWriteQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async setStartOnLaunch(enabled: boolean): Promise<void> {
    if (this.settings.startOnLaunch === enabled) return;
    const previous = this.settings.startOnLaunch;
    this.settings.startOnLaunch = enabled;
    try {
      await this.persistSettings();
    } catch (error) {
      this.settings.startOnLaunch = previous;
      throw error;
    }
  }

  private async readCacheForRollback(cachePath: string): Promise<string | undefined> {
    try {
      return await fs.readFile(cachePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  private async restoreCacheFile(cachePath: string, previous: string | undefined): Promise<void> {
    const rollbackTemporaryPath = `${cachePath}.rollback.tmp`;
    try {
      if (previous === undefined) {
        await fs.rm(cachePath, { force: true });
        return;
      }
      await fs.writeFile(rollbackTemporaryPath, previous, 'utf8');
      await fs.rename(rollbackTemporaryPath, cachePath);
    } finally {
      await fs.rm(rollbackTemporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private async restoreSubscriptionCaches(previousRaw: string | undefined, previousParsed: string | undefined): Promise<void> {
    await this.restoreCacheFile(this.parsedSubscriptionCachePath, previousParsed);
    await this.restoreCacheFile(this.subscriptionCachePath, previousRaw);
  }

  private async replaceSubscriptionCaches(raw: string, parsed: string): Promise<void> {
    const rawTemporaryPath = `${this.subscriptionCachePath}.tmp`;
    const parsedTemporaryPath = `${this.parsedSubscriptionCachePath}.tmp`;
    const [previousRaw, previousParsed] = await Promise.all([
      this.readCacheForRollback(this.subscriptionCachePath),
      this.readCacheForRollback(this.parsedSubscriptionCachePath),
    ]);
    let rawReplaced = false;
    let parsedReplaced = false;

    try {
      await Promise.all([
        fs.writeFile(rawTemporaryPath, raw, 'utf8'),
        fs.writeFile(parsedTemporaryPath, parsed, 'utf8'),
      ]);
      await fs.rename(rawTemporaryPath, this.subscriptionCachePath);
      rawReplaced = true;
      await fs.rename(parsedTemporaryPath, this.parsedSubscriptionCachePath);
      parsedReplaced = true;
    } catch (error) {
      try {
        if (parsedReplaced) {
          await this.restoreCacheFile(this.parsedSubscriptionCachePath, previousParsed);
        }
        if (rawReplaced) {
          await this.restoreCacheFile(this.subscriptionCachePath, previousRaw);
        }
      } catch (rollbackError) {
        throw new Error(
          `Subscription cache update failed and rollback could not restore the previous cache: ${(rollbackError as Error).message}`
        );
      }
      throw error;
    } finally {
      await Promise.all([
        fs.rm(rawTemporaryPath, { force: true }).catch(() => undefined),
        fs.rm(parsedTemporaryPath, { force: true }).catch(() => undefined),
      ]);
    }
  }

  async downloadCore(): Promise<ProxyState> {
    if (this.isDownloading) {
      return this.snapshot();
    }
    this.isDownloading = true;
    this.downloadProgress = 0;
    this.lastError = undefined;
    this.emitState();
    try {
      const info = await this.coreManager.download((percent) => {
        this.downloadProgress = percent;
        this.emitState();
      });
      this.coreVersion = info.version;
      // Re-downloading replaces the binary, dropping any granted privileges.
      await this.refreshTunSupport();
      if (this.settings.tunEnabled && !this.tunSupport?.available) {
        this.settings.tunEnabled = false;
        await this.persistSettings();
      }
    } catch (error) {
      this.lastError = (error as Error).message;
      throw error;
    } finally {
      this.isDownloading = false;
      this.downloadProgress = undefined;
      this.emitState();
    }
    return this.snapshot();
  }

  async saveAndFetchSubscription(url: string): Promise<ProxyState> {
    const trimmed = url.trim();
    if (!/^https?:\/\//i.test(trimmed)) {
      throw new Error('Subscription URL must start with http:// or https://');
    }
    const response = await fetch(trimmed, { headers: { 'user-agent': 'clash-verge/v1.7.7' } });
    if (!response.ok) {
      throw new Error(`Subscription download failed (HTTP ${response.status}).`);
    }
    const text = await response.text();
    const info = parseSubscription(text);
    const [previousRaw, previousParsed] = await Promise.all([
      this.readCacheForRollback(this.subscriptionCachePath),
      this.readCacheForRollback(this.parsedSubscriptionCachePath),
    ]);
    const previousProxyCount = this.settings.proxyCount;
    const previousSubscriptionUpdatedAt = this.settings.subscriptionUpdatedAt;
    await this.replaceSubscriptionCaches(text, serializeSubscriptionCache(info));
    this.settings.proxyCount = info.proxies.length;
    this.settings.subscriptionUpdatedAt = new Date().toISOString();
    try {
      await this.persistSettings();
    } catch (error) {
      if (previousProxyCount === undefined) {
        delete this.settings.proxyCount;
      } else {
        this.settings.proxyCount = previousProxyCount;
      }
      if (previousSubscriptionUpdatedAt === undefined) {
        delete this.settings.subscriptionUpdatedAt;
      } else {
        this.settings.subscriptionUpdatedAt = previousSubscriptionUpdatedAt;
      }
      try {
        await this.restoreSubscriptionCaches(previousRaw, previousParsed);
      } catch (rollbackError) {
        throw new Error(
          `Subscription metadata update failed and rollback could not restore the previous cache: ${(rollbackError as Error).message}`
        );
      }
      throw error;
    }
    this.emitState();
    return this.snapshot();
  }

  private async loadCachedSubscription(): Promise<SubscriptionInfo> {
    try {
      const cached = await fs.readFile(this.parsedSubscriptionCachePath, 'utf8');
      return parseSubscriptionCache(cached);
    } catch {
      // Fall back to the retained source cache when this is the first start
      // after upgrading or the parsed cache is incomplete/corrupt.
    }

    let raw: string;
    try {
      raw = await fs.readFile(this.subscriptionCachePath, 'utf8');
    } catch {
      throw new Error('No subscription available. Add a subscription URL first.');
    }
    const subscription = parseSubscription(raw);
    const temporaryPath = `${this.parsedSubscriptionCachePath}.tmp`;
    await fs.writeFile(temporaryPath, serializeSubscriptionCache(subscription), 'utf8');
    await fs.rename(temporaryPath, this.parsedSubscriptionCachePath);
    return subscription;
  }

  async start(): Promise<ProxyState> {
    return this.enqueueLifecycle(() => this.startNow());
  }

  private async startNow(): Promise<ProxyState> {
    if (this.runStatus === 'running' || this.runStatus === 'starting') {
      return this.snapshot();
    }

    this.setRunStatus('starting');
    try {
      const installed = await this.coreManager.getInstalledInfo();
      if (!installed) {
        throw new Error('mihomo core is not installed. Download it first.');
      }
      const subscription = await this.loadCachedSubscription();
      if (subscription.primaryGroup) {
        await this.migrateLegacySelection(subscription.primaryGroup);
      }
      const controllerPort = await this.getControllerPort();
      const secret = randomBytes(16).toString('hex');
      const config = buildRuntimeConfig(this.settings, subscription, { controllerPort, secret });
      await fs.writeFile(this.runtimeConfigPath, dumpRuntimeConfig(config), 'utf8');

      this.logLines = [];
      this.expectingExit = false;
      const child = this.spawnProcess(installed.binaryPath, ['-d', this.proxyDir, '-f', this.runtimeConfigPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.child = child;
      let rejectSpawnFailure: (error: Error) => void = () => undefined;
      const spawnFailure = new Promise<never>((_resolve, reject) => {
        rejectSpawnFailure = reject;
      });
      child.stdout?.on('data', (data: Buffer) => this.appendLog(data.toString()));
      child.stderr?.on('data', (data: Buffer) => this.appendLog(data.toString()));
      child.on('error', (error) => {
        if (this.child !== child) return;
        this.child = null;
        this.api = null;
        if (this.runStatus === 'starting') {
          rejectSpawnFailure(error);
        } else if (!this.expectingExit) {
          this.setRunStatus('error', error.message);
          void this.deactivateSystemProxyIfNeeded();
        }
      });
      child.on('exit', (code) => {
        if (this.child !== child) return;
        this.child = null;
        this.api = null;
        if (this.expectingExit) {
          this.setRunStatus('stopped');
        } else {
          this.setRunStatus('error', `mihomo exited unexpectedly (code ${code ?? 'unknown'}).`);
        }
        void this.deactivateSystemProxyIfNeeded();
      });

      this.api = new MihomoApi(controllerPort, secret);
      await Promise.race([this.waitForController(), spawnFailure]);
      await this.applySelectionsQuietly();
      if (this.expectingExit || !this.child) {
        // stop() interrupted the startup while the controller was coming up.
        this.setRunStatus('stopped');
        return this.snapshot();
      }
      this.setRunStatus('running');

      if (this.settings.systemProxyEnabled) {
        await this.activateSystemProxy();
      }
      await this.setStartOnLaunch(true);
    } catch (error) {
      // If stop() interrupted the startup, report a clean stop, not an error.
      if (this.expectingExit || this.runStatus === 'stopping' || this.runStatus === 'stopped') {
        this.setRunStatus('stopped');
        return this.snapshot();
      }
      await this.killChild();
      this.setRunStatus('error', (error as Error).message);
      throw error;
    }
    return this.snapshot();
  }

  private async waitForController(): Promise<void> {
    const deadline = Date.now() + CONTROLLER_STARTUP_TIMEOUT_MS;
    let lastFailure = 'controller did not respond';
    while (Date.now() < deadline) {
      if (!this.child) {
        throw new Error(`mihomo failed to start: ${this.logLines.slice(-5).join(' | ') || lastFailure}`);
      }
      try {
        await this.api?.getVersion();
        return;
      } catch (error) {
        lastFailure = (error as Error).message;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`mihomo controller not reachable: ${lastFailure}`);
  }

  private async applySelectionsQuietly(): Promise<void> {
    if (!this.api) return;
    const records = await this.api.getProxies();
    for (const [groupName, optionName] of validSavedProxySelections(records, this.settings.selectedProxies ?? {})) {
      try {
        await this.api.selectProxy(groupName, optionName);
      } catch {
        // A refreshed subscription may remove a group or candidate; startup continues.
      }
    }
  }

  private async migrateLegacySelection(primaryGroup: string): Promise<void> {
    if (!this.settings.selectedProxy) return;
    this.settings.selectedProxies = normalizeSavedProxySelections(
      this.settings.selectedProxies,
      this.settings.selectedProxy,
      primaryGroup
    );
    delete this.settings.selectedProxy;
    await this.persistSettings();
  }

  private async killChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.expectingExit = true;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGTERM');
    });
    this.child = null;
    this.api = null;
  }

  async stop(): Promise<ProxyState> {
    return this.enqueueLifecycle(() => this.stopNow());
  }

  private async stopNow(): Promise<ProxyState> {
    await this.setStartOnLaunch(false);
    if (this.runStatus === 'stopped' || this.runStatus === 'stopping') {
      return this.snapshot();
    }
    this.setRunStatus('stopping');
    await this.deactivateSystemProxyIfNeeded();
    await this.killChild();
    this.setRunStatus('stopped');
    return this.snapshot();
  }

  private async restart(): Promise<void> {
    await this.enqueueLifecycle(() => this.restartNow());
  }

  private async restartNow(): Promise<void> {
    if (this.runStatus !== 'running' || !this.settings.startOnLaunch) {
      return;
    }
    await this.killChild();
    this.setRunStatus('stopped');
    await this.startNow();
  }

  async setMode(mode: ProxyMode): Promise<ProxyState> {
    this.settings.mode = mode;
    await this.persistSettings();
    if (this.api && this.runStatus === 'running') {
      await this.api.patchConfigs({ mode });
    }
    this.emitState();
    return this.snapshot();
  }

  async setMixedPort(port: number): Promise<ProxyState> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('Port must be an integer between 1 and 65535.');
    }
    const systemProxyWasActive = this.systemProxyActive;
    this.settings.mixedPort = port;
    await this.persistSettings();
    if (this.runStatus === 'running') {
      await this.enqueueLifecycle(async () => {
        await this.restartNow();
        if (systemProxyWasActive && this.runStatus === 'running' && this.settings.startOnLaunch) {
          await this.activateSystemProxy();
        }
      });
    }
    this.emitState();
    return this.snapshot();
  }

  async setTun(enabled: boolean): Promise<ProxyState> {
    if (enabled) {
      await this.refreshTunSupport();
      if (!this.tunSupport?.available) {
        this.emitState();
        throw new Error(this.tunSupport?.hint ?? 'TUN mode is unavailable. Grant the core privileges first.');
      }
    }
    this.settings.tunEnabled = enabled;
    await this.persistSettings();
    if (this.runStatus === 'running') {
      await this.restart();
    }
    this.emitState();
    return this.snapshot();
  }

  private async saveCustomRules(customRules: ProxyCustomRule[]): Promise<ProxyState> {
    this.settings.customRules = customRules;
    await this.persistSettings();
    if (this.runStatus === 'running') {
      await this.restart();
    }
    this.emitState();
    return this.snapshot();
  }

  async addException(draft: ProxyExceptionDraft): Promise<ProxyState> {
    const [rule] = normalizeProxyCustomRules([
      { id: randomUUID(), type: draft.type, value: draft.value, target: draft.target },
    ]);
    return this.saveCustomRules([...this.currentCustomRules(), rule]);
  }

  async updateException(id: string, draft: ProxyExceptionDraft): Promise<ProxyState> {
    const customRules = this.currentCustomRules();
    const index = customRules.findIndex((rule) => rule.id === id);
    if (index === -1) {
      throw new Error('Custom rule was not found.');
    }

    const [rule] = normalizeProxyCustomRules([{ id, type: draft.type, value: draft.value, target: draft.target }]);
    const updated = [...customRules];
    updated[index] = rule;
    return this.saveCustomRules(updated);
  }

  async deleteException(id: string): Promise<ProxyState> {
    const customRules = this.currentCustomRules();
    if (!customRules.some((rule) => rule.id === id)) {
      throw new Error('Custom rule was not found.');
    }

    return this.saveCustomRules(customRules.filter((rule) => rule.id !== id));
  }

  private async activateSystemProxy(): Promise<void> {
    await applySystemProxy(true, this.settings.mixedPort);
    this.systemProxyActive = true;
  }

  private async deactivateSystemProxyIfNeeded(): Promise<void> {
    if (!this.systemProxyActive) return;
    try {
      await applySystemProxy(false, this.settings.mixedPort);
    } catch {
      // Best effort on teardown.
    }
    this.systemProxyActive = false;
  }

  async setSystemProxy(enabled: boolean): Promise<ProxyState> {
    return this.enqueueLifecycle(() => this.setSystemProxyNow(enabled));
  }

  private async setSystemProxyNow(enabled: boolean): Promise<ProxyState> {
    if (enabled && this.runStatus !== 'running') {
      throw new Error('Start the proxy first. When its status is running, enable System Proxy.');
    }
    if (enabled) {
      await this.activateSystemProxy();
    } else {
      // Turn off unconditionally: a stale OS entry may exist from a previous
      // session even though this process never activated it.
      await applySystemProxy(false, this.settings.mixedPort);
      this.systemProxyActive = false;
    }
    this.settings.systemProxyEnabled = enabled;
    await this.persistSettings();
    this.emitState();
    return this.snapshot();
  }

  async listProxies(): Promise<ProxyGroupsInfo> {
    if (!this.api || this.runStatus !== 'running') {
      throw new Error('Proxy is not running.');
    }
    return listManualProxyGroups(await this.api.getProxies());
  }

  async selectProxy(groupName: string, optionName: string): Promise<ProxyState> {
    if (!this.api || this.runStatus !== 'running') {
      throw new Error('Proxy is not running.');
    }
    const records = await this.api.getProxies();
    if (!findManualProxyOption(records, groupName, optionName)) {
      throw new Error('This strategy group or candidate is no longer available. Refresh the strategy groups.');
    }
    await this.api.selectProxy(groupName, optionName);
    this.settings.selectedProxies = { ...this.settings.selectedProxies, [groupName]: optionName };
    delete this.settings.selectedProxy;
    await this.persistSettings();
    this.emitState();
    return this.snapshot();
  }

  async grantTun(): Promise<ProxyState> {
    const installed = await this.coreManager.getInstalledInfo();
    if (!installed) {
      throw new Error('mihomo core is not installed. Download it first.');
    }
    await grantTunPermission(this.coreManager.binaryPath);
    await this.refreshTunSupport();
    this.emitState();
    return this.snapshot();
  }

  async revokeTun(): Promise<ProxyState> {
    await revokeTunPermission(this.coreManager.binaryPath);
    if (this.settings.tunEnabled) {
      this.settings.tunEnabled = false;
      await this.persistSettings();
      if (this.runStatus === 'running') {
        await this.restart();
      }
    }
    await this.refreshTunSupport();
    this.emitState();
    return this.snapshot();
  }

  async restoreRunningIntent(): Promise<ProxyState> {
    if (!this.settings.startOnLaunch) {
      return this.snapshot();
    }
    return this.start();
  }

  async shutdown(): Promise<void> {
    await this.enqueueLifecycle(() => this.shutdownNow());
  }

  private async shutdownNow(): Promise<void> {
    await this.deactivateSystemProxyIfNeeded();
    await this.killChild();
  }
}
