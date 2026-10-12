/**
 * A sleep that ends early when new work is signalled (wake) or on shutdown. Loops use it
 * instead of fixed polling: they react to notifications immediately and only fall back
 * to the poll interval if a notification is missed.
 * A wake() that arrives while the loop is busy is remembered, so it isn't lost.
 */
class Waker {
  constructor(signal) {
    this.signal = signal;
    this.pending = false;
    this.resolveSleep = null;
  }

  wake() {
    if (this.resolveSleep) this.resolveSleep(true);
    else this.pending = true;
  }

  // Resolves true if woken by wake(), false on timeout or shutdown.
  sleep(ms) {
    if (this.pending || this.signal.aborted) {
      const woken = this.pending;
      this.pending = false;
      return Promise.resolve(woken);
    }
    return new Promise((resolve) => {
      const done = (woken) => {
        clearTimeout(timer);
        this.signal.removeEventListener('abort', onAbort);
        this.resolveSleep = null;
        resolve(woken);
      };
      const onAbort = () => done(false);
      const timer = setTimeout(() => done(false), ms);
      this.resolveSleep = done;
      this.signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

module.exports = Waker;
