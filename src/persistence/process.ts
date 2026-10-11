import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { ConversationRecord } from '../core/state.js';

const execute = promisify(execFile);

export async function identifyProcess(
  pid: number,
): Promise<ConversationRecord['process']> {
  try {
    const { stdout } = await execute('/bin/ps', [
      '-p',
      String(pid),
      '-o',
      'lstart=',
    ]);
    return { pid, started: stdout.trim() };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 1)
      return undefined;
    throw error;
  }
}

export async function stopPreviousProcess(
  recorded: NonNullable<ConversationRecord['process']>,
): Promise<void> {
  const current = await identifyProcess(recorded.pid);
  if (!current || current.started !== recorded.started) return;
  process.kill(recorded.pid, 'SIGTERM');
  for (let attempt = 0; attempt < 50; attempt++) {
    await delay(100);
    const remaining = await identifyProcess(recorded.pid);
    if (!remaining || remaining.started !== recorded.started) return;
  }
  throw new Error(
    `The previous agent process (${recorded.pid}) has not stopped. Stop it before restarting Witch.`,
  );
}
