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

// One Mutex per key (e.g. per agent): one agent's payment never waits for another agent
export class KeyedMutex {
  private locks = new Map<string, Mutex>()
  for(key: string): Mutex {
    let m = this.locks.get(key)
    if (!m) { m = new Mutex(); this.locks.set(key, m) }
    return m
  }
}
