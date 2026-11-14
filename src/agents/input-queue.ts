export class InputQueue<T> implements AsyncIterable<T> {
  private items: { value: T; consumed: () => void }[] = [];
  private waiting = Promise.withResolvers<void>();
  private ended = false;
  private flushed = Promise.resolve();

  push(item: T): void {
    if (this.ended) throw new Error('Agent input is closed');

    const consumed = Promise.withResolvers<void>();
    this.flushed = consumed.promise;
    this.items.push({ value: item, consumed: consumed.resolve });
    this.waiting.resolve();
  }

  /** waits for consumer processing of all inputs queued before this call. */
  flush(): Promise<void> {
    return this.flushed;
  }

  close(): void {
    this.ended = true;
    this.waiting.resolve();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (!this.ended || this.items.length > 0) {
      if (this.items.length === 0) {
        await this.waiting.promise;
        this.waiting = Promise.withResolvers<void>();
      }

      while (this.items.length > 0) {
        const item = this.items.shift()!;
        yield item.value;
        item.consumed();
      }
    }
  }
}
