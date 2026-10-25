export class TurnText {
  private readonly messages = new Map<string, string>();

  append(id: string, text: string): void {
    this.messages.set(id, (this.messages.get(id) ?? '') + text);
  }

  replace(id: string, text: string): void {
    this.messages.set(id, text);
  }

  get text(): string {
    return [...this.messages.values()].join('\n\n');
  }
}
