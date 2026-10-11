import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import fsExt from 'fs-ext';
import { appDataSchema, displayUpdateSchema } from '../core/state.js';
import type { AppData, DisplayUpdate } from '../core/state.js';

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export class StateStore {
  private queue: Promise<unknown> = Promise.resolve();
  private failure?: Error;
  private histories = new Map<string, FileHandle>();

  private constructor(
    readonly root: string,
    private readonly lock: FileHandle,
  ) {}

  static async open(root: string): Promise<StateStore> {
    await mkdir(join(root, 'history'), { recursive: true, mode: 0o700 });
    const lock = await open(join(root, 'instance.lock'), 'a', 0o600);
    try {
      fsExt.flockSync(lock.fd, 'exnb');
    } catch (error) {
      await lock.close();
      throw new Error(
        'Another harness is already running for this state directory',
        { cause: error },
      );
    }
    return new StateStore(root, lock);
  }

  async load(): Promise<AppData> {
    try {
      return appDataSchema.parse(
        JSON.parse(await readFile(join(this.root, 'state.json'), 'utf8')),
      );
    } catch (error) {
      if (missing(error)) return { version: 1, conversations: [] };
      throw error;
    }
  }

  save(data: AppData): Promise<void> {
    const content = `${JSON.stringify(data, null, 2)}\n`;
    return this.enqueue(async () => {
      const temporary = join(this.root, `state-${randomUUID()}.tmp`);
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(content);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, join(this.root, 'state.json'));
    });
  }

  append(conversation: string, update: DisplayUpdate): Promise<void> {
    const line = `${JSON.stringify(update)}\n`;
    return this.enqueue(async () => {
      let file = this.histories.get(conversation);
      if (!file) {
        file = await open(this.historyPath(conversation), 'a+', 0o600);
        const existing = await file.readFile();
        if (existing.length && existing.at(-1) !== 10) {
          await file.truncate(existing.lastIndexOf(10) + 1);
        }
        this.histories.set(conversation, file);
      }
      await file.write(line);
    });
  }

  async history(conversation: string): Promise<DisplayUpdate[]> {
    await this.flush();
    try {
      const content = await readFile(this.historyPath(conversation), 'utf8');
      const lines = content.split('\n');
      if (!content.endsWith('\n')) lines.pop();
      return lines
        .filter(Boolean)
        .map((line) => displayUpdateSchema.parse(JSON.parse(line)));
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
  }

  async flush(): Promise<void> {
    await this.queue;
    if (this.failure) throw this.failure;
    await Promise.all([...this.histories.values()].map((file) => file.sync()));
  }

  async close(): Promise<void> {
    try {
      await this.flush();
    } finally {
      await Promise.all(
        [...this.histories.values()].map((file) => file.close()),
      );
      this.histories.clear();
      await this.lock.close();
    }
  }

  private historyPath(conversation: string): string {
    return join(
      this.root,
      'history',
      `${encodeURIComponent(conversation)}.jsonl`,
    );
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.queue.then(() => {
      if (this.failure) throw this.failure;
      return operation();
    });
    this.queue = next.catch((error: unknown) => {
      this.failure = error instanceof Error ? error : new Error(String(error));
    });
    return next;
  }
}
