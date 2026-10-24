import { execFile } from 'node:child_process';
import type { ExecFileException, ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';
import type { Run } from './repository.js';

const execute = promisify(execFile);

/** without a child handle or abort signal, a rejected command's killed flag identifies its timeout. */
export async function runCommand(
  command: string,
  args: string[],
  options: Parameters<Run>[2] & Pick<ExecFileOptions, 'env' | 'killSignal'>,
): ReturnType<Run> {
  try {
    return await execute(command, args, options);
  } catch (error) {
    const failure = error as ExecFileException;
    if (failure.killed === true)
      failure.message = `Timed out after ${options.timeout} ms: ${failure.message}`;
    throw error;
  }
}
