// Local-only notification: wait during an active job, sleep normally when idle.
// `take` must claim synchronously, so multiple receivers cannot get the same command.
export class CommandNotifier {
  #waiters = new Set();
  get waitingCount() { return this.#waiters.size; }

  wait(take, timeoutMs = 0, signal) {
    if (signal?.aborted) return Promise.resolve(null);
    const immediate = take();
    if (immediate !== undefined) return Promise.resolve(immediate);
    if (!timeoutMs) return Promise.resolve(null);
    if (this.#waiters.size >= 8) return Promise.reject(new Error('Too many command receivers'));
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (value, error) => {
        this.#waiters.delete(check);
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value);
      };
      const abort = () => finish(null);
      const check = () => {
        if (signal?.aborted) { finish(null); return; }
        try { const value = take(); if (value !== undefined) finish(value); }
        catch (error) { finish(null, error); }
      };
      this.#waiters.add(check);
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => finish(null), timeoutMs);
      check();
    });
  }

  notify() { for (const check of [...this.#waiters]) check(); }
}
