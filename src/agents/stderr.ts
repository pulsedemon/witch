import type { ChildProcess } from 'node:child_process';

export interface ChildExit {
  /** resolves once the child exited or failed to spawn and both output streams closed. */
  readonly closed: Promise<void>;
  /** whether the child has exited, set before listeners added after this one run. */
  readonly exited: boolean;
  /** the last 4 KB of its stderr. */
  tail(): string;
}

/** watches a child from its spawn, since a failed spawn emits `close` and no `exit`. */
export function watchChild(child: ChildProcess): ChildExit {
  let tail = '';
  let exited = false;
  const closed = new Promise<void>((resolve) =>
    child.once('close', () => resolve()),
  );
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (text: string) => {
    tail = (tail + text).slice(-4096);
  });
  child.once('exit', () => {
    exited = true;
    // a grandchild holding the pipes would otherwise keep `close` from firing
    setTimeout(() => {
      for (const stream of [child.stdout, child.stderr])
        if (stream && !stream.destroyed) {
          stream.push(null);
          stream.destroy();
        }
    }, 200);
  });
  return {
    closed,
    get exited() {
      return exited;
    },
    tail: () => tail.trim(),
  };
}

/** appends a stderr tail to an error message. */
export function withTail(message: string, tail: string): string {
  return tail ? `${message}: ${tail}` : message;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
