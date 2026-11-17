export class TurnText {
  private readonly messages = new Map<string, string>();

  append(id: string, text: string): void {
    this.messages.set(id, (this.messages.get(id) ?? '') + text);
  }

  replace(id: string, text: string): void {
    this.messages.set(id, text);
  }

  delete(id: string): void {
    this.messages.delete(id);
  }

  get text(): string {
    return [...this.messages.values()].join('\n\n');
  }

  get last(): string {
    return [...this.messages.values()].at(-1) ?? '';
  }
}
