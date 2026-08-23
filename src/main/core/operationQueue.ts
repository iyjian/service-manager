export class KeyedOperationQueue {
  private readonly tails = new Map<string, Promise<void>>();

  runMany<T>(keys: readonly string[], task: () => Promise<T>): Promise<T> {
    const orderedKeys = [...new Set(keys)].sort();

    const acquire = (index: number): Promise<T> => {
      if (index >= orderedKeys.length) {
        return task();
      }
      return this.run(orderedKeys[index], () => acquire(index + 1));
    };

    return acquire(0);
  }

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    this.tails.set(key, tail);

    await previous.catch(() => undefined);

    try {
      return await task();
    } finally {
      release();
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }
}
