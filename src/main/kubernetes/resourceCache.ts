interface CacheEntry {
  value: unknown;
  touchedAt: number;
}

/**
 * In-memory request cache for inactive resource queries. It is intentionally
 * persistence-free: entries expire after inactivity and are evicted in LRU
 * order when the bounded cache is full.
 */
export class ResourceCache<T> {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private generation = 0;

  public constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error('maxEntries must be a positive integer.');
    }
    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new Error('ttlMs must be a non-negative finite number.');
    }
  }

  public get<Value = T>(key: string): Value | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }

    const timestamp = this.now();
    if (this.isExpired(entry, timestamp)) {
      this.entries.delete(key);
      return undefined;
    }

    this.touch(key, entry.value, timestamp);
    return entry.value as Value;
  }

  public set<Value = T>(key: string, value: Value): void {
    // A direct value is newer than any request that was already in flight.
    // Removing its pending identity prevents a late completion from replacing
    // this explicit cache write.
    this.pending.delete(key);
    const timestamp = this.now();
    this.evictExpiredAt(timestamp);
    this.touch(key, value, timestamp);
    this.evictLeastRecentlyUsed();
  }

  public getOrCreate<Value = T>(key: string, load: () => Promise<Value>): Promise<Value> {
    const cached = this.get<Value>(key);
    if (cached !== undefined) {
      return Promise.resolve(cached);
    }

    const existing = this.pending.get(key);
    if (existing) {
      return existing as Promise<Value>;
    }

    const generation = this.generation;
    const request = Promise.resolve().then(load) as Promise<unknown>;
    this.pending.set(key, request);

    void request.then(
      (value) => {
        if (this.generation === generation && this.pending.get(key) === request) {
          this.set(key, value);
        }
      },
      () => {
        // This handler is registered before the caller receives `request`, so
        // deletion happens before that caller's rejection handler can retry.
        if (this.pending.get(key) === request) {
          this.pending.delete(key);
        }
      }
    );

    return request as Promise<Value>;
  }

  public evictExpired(): void {
    this.evictExpiredAt(this.now());
  }

  public clear(): void {
    this.generation += 1;
    this.entries.clear();
    this.pending.clear();
  }

  private isExpired(entry: CacheEntry, timestamp: number): boolean {
    return timestamp - entry.touchedAt >= this.ttlMs;
  }

  private evictExpiredAt(timestamp: number): void {
    for (const [key, entry] of this.entries) {
      if (this.isExpired(entry, timestamp)) {
        this.entries.delete(key);
      }
    }
  }

  private touch(key: string, value: unknown, timestamp: number): void {
    this.entries.delete(key);
    this.entries.set(key, { value, touchedAt: timestamp });
  }

  private evictLeastRecentlyUsed(): void {
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) {
        return;
      }
      this.entries.delete(oldestKey);
    }
  }
}
