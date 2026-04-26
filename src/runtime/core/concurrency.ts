export class SingleFlight<T> {
  private readonly pending = new Map<string, Promise<T>>();

  do(key: string, operation: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key);
    if (existing) {
      return existing;
    }

    const pending = Promise.resolve()
      .then(operation)
      .finally(() => {
        if (this.pending.get(key) === pending) {
          this.pending.delete(key);
        }
      });
    this.pending.set(key, pending);
    return pending;
  }
}

export class SerialActor {
  private tail: Promise<void> = Promise.resolve();

  dispatch<T>(operation: () => Promise<T> | T): Promise<T> {
    const run = this.tail.then(operation, operation);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  drain(): Promise<void> {
    return this.tail;
  }
}

export function emitSafely<T>(
  watchers: Iterable<(update: T) => void>,
  update: T,
  onError?: (error: unknown) => void,
): void {
  for (const watcher of [...watchers]) {
    try {
      watcher(update);
    } catch (error) {
      onError?.(error);
    }
  }
}
