import { cp } from 'node:fs/promises';
import { join } from 'node:path';
import { Memory } from '../../src/memory/memory.js';
import type { GitRunner } from '../../src/memory/memory.js';
import { scratch } from './scratch.js';

let template: Promise<string> | undefined;

/** a Memory over a copy of one repository `initialize` built in this test file's scratch, saving its six git processes per fixture. */
export async function seededMemory(
  root: string,
  runner?: GitRunner,
): Promise<Memory> {
  template ??= build();
  await cp(await template, root, { recursive: true });
  return new Memory(root, runner);
}

async function build(): Promise<string> {
  const memory = new Memory(
    join(await scratch('witch-memory-template-'), 'memory.git'),
  );
  await memory.initialize();
  return memory.root;
}
