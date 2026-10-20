/** each caller controls only its own source; subscribers hear aggregate activity changes. */
export class PentacleActivity {
  private readonly sources = new Set<symbol>();
  private readonly listeners = new Set<() => void>();

  get active(): boolean {
    return this.sources.size > 0;
  }

  set(source: symbol, active: boolean): void {
    const previous = this.active;
    if (active) this.sources.add(source);
    else this.sources.delete(source);
    if (this.active !== previous)
      for (const listener of this.listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}
