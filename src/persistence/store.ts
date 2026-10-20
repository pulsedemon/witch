import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { errorMessage } from '../agents/stderr.js';
import {
  conversationRecordSchema,
  displayUpdateSchema,
  foldDisplayUpdates,
} from '../core/state.js';
import type {
  Conversation,
  ConversationRecord,
  DisplayItem,
  DisplayUpdate,
} from '../core/state.js';
import { stopPreviousProcess, stopPreviousShell } from './process.js';
import { exclusiveLock, isLocked } from './lock.js';

const promptSchema = z.object({ cwd: z.string(), text: z.string() });

// ENOTDIR covers a stray file, such as Finder's .DS_Store, where a conversation directory would be
function missing(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

function conversationsPath(root: string): string {
  return join(root, 'conversations');
}

function recordPath(directory: string): string {
  return join(directory, 'state.json');
}

function historyPath(directory: string): string {
  return join(directory, 'history.jsonl');
}

export class LockedElsewhere extends Error {}

async function tryLock(directory: string): Promise<FileHandle> {
  try {
    return await open(
      join(directory, 'lock'),
      constants.O_RDWR |
        constants.O_CREAT |
        constants.O_NONBLOCK |
        exclusiveLock,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EAGAIN')
      throw new LockedElsewhere(
        'This conversation is open in another Witch instance or being recovered.',
        { cause: error },
      );
    throw error;
  }
}

async function readRecord(directory: string): Promise<ConversationRecord> {
  return conversationRecordSchema.parse(
    JSON.parse(await readFile(recordPath(directory), 'utf8')),
  );
}

interface UnreadableRecord {
  file: string;
  error: string;
}

export class StateStore {
  private adding: Promise<void> = Promise.resolve();

  private constructor(readonly root: string) {}

  static async open(root: string): Promise<StateStore> {
    await mkdir(conversationsPath(root), { recursive: true, mode: 0o700 });
    return new StateStore(root);
  }

  async records(): Promise<{
    records: ConversationRecord[];
    unreadable: UnreadableRecord[];
  }> {
    const records: ConversationRecord[] = [];
    const unreadable: UnreadableRecord[] = [];
    for (const id of await readdir(conversationsPath(this.root))) {
      try {
        records.push(await readRecord(this.directory(id)));
      } catch (error) {
        if (!missing(error))
          unreadable.push({
            file: recordPath(this.directory(id)),
            error: errorMessage(error),
          });
      }
    }
    return { records, unreadable };
  }

  /** conversations that have history, newest first: this directory's, or every directory's without one. */
  async conversations(cwd?: string): Promise<Conversation[]> {
    const listed: { conversation: Conversation; modified: number }[] = [];
    for (const record of (await this.records()).records) {
      if (cwd !== undefined && record.cwd !== cwd) continue;
      const history = await stat(historyPath(this.directory(record.id))).catch(
        (error: unknown) => {
          if (missing(error)) return undefined;
          throw error;
        },
      );
      if (history?.size)
        listed.push({ conversation: record, modified: history.mtimeMs });
    }
    return listed
      .sort((a, b) => b.modified - a.modified)
      .map(({ conversation }) => conversation);
  }

  /** the prompts sent in `cwd`, newest first, skipping a line a crash cut short. */
  async prompts(cwd: string): Promise<string[]> {
    const content = await readFile(this.promptsPath(), 'utf8').catch(
      (error: unknown) => {
        if (missing(error)) return '';
        throw error;
      },
    );
    return content
      .split('\n')
      .flatMap((line) => {
        try {
          const prompt = promptSchema.parse(JSON.parse(line));
          return prompt.cwd === cwd ? [prompt.text] : [];
        } catch {
          return [];
        }
      })
      .reverse();
  }

  /** waits for the prompts added before it, so the file keeps their order, and starts with the line break, so a line a crash cut short ends before it. */
  addPrompt(cwd: string, text: string): Promise<void> {
    const added = this.adding.then(async () => {
      const file = await open(this.promptsPath(), 'a', 0o600);
      try {
        // one write call, which other instances' appends never split; appendFile writes 512 KiB at a time
        await file.write(Buffer.from(`\n${JSON.stringify({ cwd, text })}`));
      } finally {
        await file.close();
      }
    });
    this.adding = added.catch(() => {});
    return added;
  }

  /** locks before writing `state.json`, so `records()` never lists an unlocked new conversation. */
  async create(conversation: Conversation): Promise<ConversationStore> {
    const directory = this.directory(conversation.id);
    await mkdir(directory, { mode: 0o700 });
    const lock = await tryLock(directory);
    const files = new ConversationStore(directory, lock, conversation);
    try {
      await files.save(conversation);
    } catch (error) {
      await files.close().catch(() => {});
      throw error;
    }
    return files;
  }

  async claim(id: string): Promise<ConversationStore> {
    const directory = this.directory(id);
    const lock = await tryLock(directory);
    try {
      const record = await readRecord(directory);
      const files = new ConversationStore(directory, lock, record);
      if (record.shell || record.process) {
        // the shell goes first, so a CLI that won't stop still leaves the command killed
        if (record.shell) await stopPreviousShell(record.shell);
        if (record.process) await stopPreviousProcess(record.process);
        delete record.shell;
        delete record.process;
        await files.save(record);
      }
      return files;
    } catch (error) {
      await lock.close();
      throw error;
    }
  }

  /** observes ownership without creating a lock or recovering native processes. */
  isOpen(id: string): Promise<boolean> {
    return isLocked(join(this.directory(id), 'lock'));
  }

  private directory(id: string): string {
    return join(conversationsPath(this.root), id);
  }

  private promptsPath(): string {
    return join(this.root, 'prompts.jsonl');
  }
}

export class ConversationStore {
  private queue: Promise<unknown> = Promise.resolve();
  private failure?: Error;
  private historyFile?: FileHandle;
  private released = false;

  constructor(
    readonly directory: string,
    private readonly lock: FileHandle,
    readonly record: ConversationRecord,
  ) {}

  get closed(): boolean {
    return this.released;
  }

  save(record: ConversationRecord): Promise<void> {
    const content = `${JSON.stringify(record, null, 2)}\n`;
    return this.enqueue(async () => {
      const temporary = join(this.directory, `state-${randomUUID()}.tmp`);
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(content);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, recordPath(this.directory));
    });
  }

  append(update: DisplayUpdate): Promise<void> {
    const line = `${JSON.stringify(update)}\n`;
    return this.enqueue(async () => {
      if (!this.historyFile) {
        const file = await open(historyPath(this.directory), 'a+', 0o600);
        const existing = await file.readFile();
        if (existing.length && existing.at(-1) !== 10) {
          await file.truncate(existing.lastIndexOf(10) + 1);
        }
        this.historyFile = file;
      }
      await this.historyFile.writeFile(line);
    });
  }

  async history(): Promise<DisplayUpdate[]> {
    await this.flush();
    try {
      const content = await readFile(historyPath(this.directory), 'utf8');
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

  async items(): Promise<DisplayItem[]> {
    return foldDisplayUpdates(await this.history());
  }

  async flush(): Promise<void> {
    await this.queue;
    if (this.failure) throw this.failure;
    await this.historyFile?.sync();
  }

  async close(): Promise<void> {
    if (this.released) return;
    this.released = true;
    try {
      await this.flush();
    } finally {
      await this.historyFile?.close();
      this.historyFile = undefined;
      await this.lock.close();
    }
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    if (this.released)
      return Promise.reject(new Error('This conversation is no longer open.'));
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
