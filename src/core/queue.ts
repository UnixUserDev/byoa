/**
 * A single-consumer async queue.
 *
 * This is what makes the core's event stream work: the agent pushes AgentEvents in,
 * the frontend adapter pulls them out with `for await`, and neither blocks the other.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  #items: T[] = []
  #waiters: Array<(result: IteratorResult<T>) => void> = []
  #closed = false

  get closed(): boolean {
    return this.#closed
  }

  push(item: T): void {
    if (this.#closed) return
    const waiter = this.#waiters.shift()
    if (waiter) waiter({ value: item, done: false })
    else this.#items.push(item)
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    const waiters = this.#waiters
    this.#waiters = []
    for (const waiter of waiters) waiter({ value: undefined as never, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const item = this.#items.shift()
        if (item !== undefined) return Promise.resolve({ value: item, done: false })
        if (this.#closed) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise<IteratorResult<T>>((resolve) => {
          this.#waiters.push(resolve)
        })
      },
      return: (): Promise<IteratorResult<T>> => {
        this.close()
        return Promise.resolve({ value: undefined as never, done: true })
      },
    }
  }
}
