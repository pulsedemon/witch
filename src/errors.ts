import type { ZodError } from 'zod';

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** a schema failure on one line, each issue under its path; zod's own message is a JSON document. */
export function issuesText(error: ZodError): string {
  return error.issues
    .map(({ path, message }) =>
      path.length ? `${path.join('.')}: ${message}` : message,
    )
    .join('; ');
}

/** the message `work` fails with, or undefined once it succeeds. */
export function failureOf(work: Promise<unknown>): Promise<string | undefined> {
  return work.then(() => undefined, errorMessage);
}

export function aborted(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
