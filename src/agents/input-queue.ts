export class InputQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiting = Promise.withResolvers<void>();
  private ended = false;

  push(item: T): void {
    if (this.ended) throw new Error('Agent input is closed');
    this.items.push(item);
    this.waiting.resolve();
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
      while (this.items.length > 0) yield this.items.shift()!;
    }
  }
}
