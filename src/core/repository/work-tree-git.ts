import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Run } from './repository.js';

export type GitRun = (
  command: string,
  args: string[],
  options: Parameters<Run>[2] & { input?: string },
) => ReturnType<Run>;

const run = promisify(execFile);

export const execute: GitRun = async (command, args, { input, ...options }) => {
  const result = run(command, args, options);
  // the process failure carries the diagnostic when stdin also closes with EPIPE.
  result.child.stdin?.on('error', () => {}).end(input);

  return result;
};
