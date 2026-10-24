import { availableParallelism } from 'node:os';

export const testWorkers = Math.min(4, availableParallelism());
export const vitestFiles: readonly string[] = [
  'test/claude-background.test.ts',
  'test/claude-compaction.test.ts',
  'test/claude-diff.test.ts',
  'test/claude-shell.test.ts',
  'test/claude-usage.test.ts',
  'test/claude.test.ts',
  'test/cli-desktop.test.ts',
  'test/cli.test.ts',
  'test/codex-approvals.test.ts',
  'test/codex-compaction.test.ts',
  'test/codex-context.test.ts',
  'test/codex-questions.test.ts',
  'test/codex.test.ts',
  'test/command.test.ts',
  'test/completion.test.ts',
  'test/control.test.ts',
  'test/coordination-requests.test.ts',
  'test/coordination-store.test.ts',
  'test/coordination.test.ts',
  'test/coordinator-session.test.ts',
  'test/diff.test.ts',
  'test/directory-recovery.test.ts',
  'test/files.test.ts',
  'test/github-assignment.test.ts',
  'test/images.test.ts',
  'test/input-queue.test.ts',
  'test/input.test.ts',
  'test/installation.test.ts',
  'test/instance.test.ts',
  'test/jobs-restart.test.ts',
  'test/jobs.test.ts',
  'test/layout-resize.test.ts',
  'test/layout.test.ts',
  'test/links.test.ts',
  'test/lock.test.ts',
  'test/markdown.test.ts',
  'test/memory-adoption.test.ts',
  'test/memory-context.test.ts',
  'test/memory.test.ts',
  'test/merged-watch.test.ts',
  'test/merged.test.ts',
  'test/model-discovery.test.ts',
  'test/models.test.ts',
  'test/mouse.test.ts',
  'test/notification-schedule.test.ts',
  'test/pentacle-activity.test.ts',
  'test/pentacle.test.ts',
  'test/process.test.ts',
  'test/registry.test.ts',
  'test/repository.test.ts',
  'test/rpc.test.ts',
  'test/scratch-lifetime.test.ts',
  'test/scratch-usage.test.ts',
  'test/scratch.test.ts',
  'test/screen.test.ts',
  'test/selection.test.ts',
  'test/status-line.test.ts',
  'test/store.test.ts',
  'test/task-selection-cli.test.ts',
  'test/task-selection-store.test.ts',
  'test/task-selection.test.ts',
  'test/terminal.test.ts',
  'test/test-runner.test.ts',
  'test/ui-status.test.ts',
  'test/user-shell.test.ts',
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
