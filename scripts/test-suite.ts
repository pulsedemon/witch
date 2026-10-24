import { availableParallelism } from 'node:os';

export const testWorkers = Math.min(4, availableParallelism());
export const vitestFiles: readonly string[] = ['test/rpc.test.ts'];

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
