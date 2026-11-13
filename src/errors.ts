export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** the message `work` fails with, or undefined once it succeeds. */
export function failureOf(work: Promise<unknown>): Promise<string | undefined> {
  return work.then(() => undefined, errorMessage);
}

export function aborted(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
