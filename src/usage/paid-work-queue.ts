export type PaidWorkPriority = 'background' | 'interactive';

interface PendingWork<T> {
  readonly operation: () => Promise<T>;
  readonly reject: (reason: unknown) => void;
  readonly resolve: (value: T | PromiseLike<T>) => void;
}

export class PaidWorkQueue {
  readonly #background: PendingWork<unknown>[] = [];
  readonly #idleWaiters: (() => void)[] = [];
  readonly #interactive: PendingWork<unknown>[] = [];
  #accepting = true;
  #running = false;

  public background<T>(operation: () => Promise<T>): Promise<T> {
    return this.#submit('background', operation);
  }

  public interactive<T>(operation: () => Promise<T>): Promise<T> {
    return this.#submit('interactive', operation);
  }

  public shutdown(): Promise<void> {
    this.#accepting = false;
    if (!this.#running && this.#pendingCount() === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#idleWaiters.push(resolve);
    });
  }

  #submit<T>(
    priority: PaidWorkPriority,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!this.#accepting) {
      return Promise.reject(new Error('paid work queue is closed'));
    }
    return new Promise<T>((resolve, reject) => {
      const work: PendingWork<T> = { operation, reject, resolve };
      (priority === 'interactive' ? this.#interactive : this.#background).push(
        work as PendingWork<unknown>,
      );
      this.#startNext();
    });
  }

  #startNext(): void {
    if (this.#running) return;
    const work = this.#interactive.shift() ?? this.#background.shift();
    if (work === undefined) return;
    this.#running = true;
    void Promise.resolve()
      .then(work.operation)
      .then(work.resolve, work.reject)
      .finally(() => {
        this.#running = false;
        if (this.#pendingCount() > 0) this.#startNext();
        else this.#resolveIdle();
      });
  }

  #pendingCount(): number {
    return this.#interactive.length + this.#background.length;
  }

  #resolveIdle(): void {
    for (const resolve of this.#idleWaiters.splice(0)) resolve();
  }
}
