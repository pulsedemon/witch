import { availableParallelism } from 'node:os';

export const testWorkers = Math.min(4, availableParallelism());
export const vitestFiles: readonly string[] = [
  'test/claude-background.test.ts',
  'test/cli-desktop.test.ts',
  'test/cli.test.ts',
  'test/coordinator-session.test.ts',
  'test/jobs.test.ts',
  'test/memory.test.ts',
  'test/rpc.test.ts',
  'test/scratch-lifetime.test.ts',
  'test/scratch.test.ts',
  'test/terminal.test.ts',
  'test/ui-status.test.ts',
];

export function partitionTests(files: readonly string[]): {
  vitest: string[];
  node: string[];
} {
  const missing = vitestFiles.filter((file) => !files.includes(file));
  if (missing.length)
    throw new Error(`Missing migrated test files: ${missing.join(', ')}`);
  const migrated = new Set(vitestFiles);
  return {
    vitest: files.filter((file) => migrated.has(file)),
    node: files.filter((file) => !migrated.has(file)),
  };
}
