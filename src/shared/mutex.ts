// Only one payment (or anchor) spends the wallet at a time.
// Without this, two simultaneous operations would take the same coin → double spend refused.
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve()
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn)
    this.tail = result.catch(() => undefined)
    return result
  }
}
