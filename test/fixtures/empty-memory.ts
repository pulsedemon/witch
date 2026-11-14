import assert from 'node:assert/strict';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Memory } from '../../src/memory/memory.js';
import type { MemoryScope } from '../../src/memory/memory.js';
import { Workspace } from '../../src/memory/workspace.js';

const revision = '0'.repeat(40);
const integration = 'Use the real memory fixture for memory integration tests';

/** clean, unchanged memory for coordinator tests; persistence and note edits require the real fixture. */
export class EmptyMemory extends Memory {
  private readonly workspaces = new Map<string, EmptyWorkspace>();

  override async run(...args: Parameters<Memory['run']>) {
    const [cwd] = args;

    assert.ok(cwd !== this.root && !this.workspaces.has(cwd), integration);

    return super.run(...args);
  }

  override async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  override async unpublished(): Promise<string[]> {
    return [];
  }

  override workspace(directory: string, id: string): Workspace {
    const root = join(directory, 'memory');
    let workspace = this.workspaces.get(root);

    if (!workspace) {
      workspace = new EmptyWorkspace(this, root, id);

      this.workspaces.set(root, workspace);
    }

    return workspace;
  }

  override async resolve(): Promise<string> {
    return revision;
  }

  override async snapshot(): Promise<string> {
    return `Accepted shared memory, revision ${revision}.\n\nFixture memory snapshot.`;
  }
}

class EmptyWorkspace extends Workspace {
  private created = false;

  override async exists(): Promise<boolean> {
    return this.created;
  }

  override async branchExists(): Promise<boolean> {
    return this.created;
  }

  override async ensureWorktree(): Promise<void> {
    await mkdir(this.root, { recursive: true });

    this.created = true;
  }

  override async rebaseStopped(): Promise<boolean> {
    return false;
  }

  override async revision(): Promise<string> {
    return revision;
  }

  override async status() {
    const entries = await readdir(this.root, {
      recursive: true,
      withFileTypes: true,
    });

    assert.ok(
      entries.every((entry) => entry.isDirectory()),
      integration,
    );

    return { dirty: false, head: revision, ahead: 0, behind: 0 };
  }

  override async begin(scope: MemoryScope) {
    await this.status();

    await this.prepare(scope);

    return { revision, repointed: 0 };
  }

  override async adoptCheckout() {
    await this.status();

    return { repointed: 0 };
  }

  override async commit(): Promise<void> {
    await this.status();
  }

  override async publish() {
    await this.status();

    return 'published' as const;
  }
}
