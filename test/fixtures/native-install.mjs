import process from 'node:process';
import { readFile } from 'node:fs/promises';
import { installNative } from '../../src/agents/native-install.ts';

await installNative(
  JSON.parse(await readFile(process.argv[2], 'utf8')),
  process.argv[4],
  process.argv[3],
  globalThis.AbortSignal.timeout(Number(process.argv[5] ?? 10000)),
);
