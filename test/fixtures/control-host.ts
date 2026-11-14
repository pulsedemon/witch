import { randomUUID } from 'node:crypto';
import { promises as files } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';
import { ControlHost } from '../../src/persistence/control.js';
import type {
  ControlBinding,
  ControlRequest,
} from '../../src/persistence/control.js';
import { identifyProcess } from '../../src/persistence/process.js';
import { scratch } from './scratch.js';
import { until } from './within.js';

export const identity = (await identifyProcess(process.pid))!;

export async function binding(): Promise<ControlBinding> {
  return {
    directory: await scratch('witch-control-'),
    conversation: 'conversation-a',
    activation: randomUUID(),
  };
}

export function envelope(bound: ControlBinding): ControlRequest {
  return {
    id: randomUUID(),
    version: 1,
    conversation: bound.conversation,
    activation: bound.activation,
    deadline: Date.now() + 5000,
    action: { kind: 'peers' },
  };
}

/** a host that releases every request, counting how many reach its handler. */
export async function countingHost(bound: ControlBinding) {
  let calls = 0;

  const failures: unknown[] = [];

  const host = await ControlHost.open(
    bound.directory,
    async () => {
      calls++;

      return { kind: 'released' };
    },
    (error) => failures.push(error),
  );

  return { host, failures, calls: () => calls };
}

/** on macOS a write just after `ControlHost.open` can send no event, so this waits for one; the host skips names that aren't `.json`. */
export async function watching(directory: string): Promise<void> {
  const readdir = vi.spyOn(files, 'readdir');

  const probe = join(directory, 'inbox', 'probe');

  try {
    await until('a live watch', async () => {
      if (readdir.mock.calls.length) return true;

      await files.writeFile(probe, '');

      return false;
    });

    const reads = readdir.mock.calls.length;

    await files.rm(probe);

    await until(
      'the probe removal read',
      () => readdir.mock.calls.length > reads,
    );
  } finally {
    readdir.mockRestore();
  }
}
