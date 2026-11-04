import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  mkdir,
  open,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { errorMessage } from '../agents/stderr.js';
import { unnumbered } from '../core/attachments.js';
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
import { mapper, readLedger } from './directories.js';
import { replaceFile, writeJson } from './json.js';
import { stopPreviousProcess, stopPreviousShell } from './process.js';
import { lockedFiles, tryOpenLocked } from './lock.js';

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

async function tryLock(file: string, shared = false): Promise<FileHandle> {
  const handle = await tryOpenLocked(
    file,
    constants.O_RDWR | constants.O_CREAT,
    { mode: 0o600, shared },
  );
  if (!handle)
    throw new LockedElsewhere(
      'This conversation is open in another Witch instance or being recovered.',
    );
  return handle;
}

/** current Witches serialize on `coordinated`; the shared conversation lock excludes legacy owners and identifies current ones. */
async function hold(directory: string): Promise<() => Promise<void>> {
  const coordinated = await tryLock(join(directory, 'coordinated'));
  let lock: FileHandle;
  try {
    lock = await tryLock(join(directory, 'lock'), true);
  } catch (error) {
    await coordinated.close();
    throw error;
  }
  return async () => {
    try {
      await lock.close();
    } finally {
      await coordinated.close();
    }
  };
}

async function readRecord(directory: string): Promise<ConversationRecord> {
  return conversationRecordSchema.parse(
    JSON.parse(await readFile(recordPath(directory), 'utf8')),
  );
}

/** `modified`, the time the listing sorts by, is when its history, or its record without history, last changed, in epoch milliseconds. */
export type ListedConversation = Conversation & { modified: number };

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

  async records(ids?: readonly string[]): Promise<{
    records: ConversationRecord[];
    unreadable: UnreadableRecord[];
  }> {
    const records: ConversationRecord[] = [];
    const unreadable: UnreadableRecord[] = [];
    for (const id of ids ?? (await readdir(conversationsPath(this.root)))) {
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

  /** conversations that have history or a saved draft or queue, newest first: this directory's, or every directory's without one. */
  async conversations(cwd?: string): Promise<ListedConversation[]> {
    const listed: ListedConversation[] = [];
    for (const record of (await this.records()).records) {
      if (cwd !== undefined && record.cwd !== cwd) continue;
      const directory = this.directory(record.id);
      const history = await stat(historyPath(directory)).catch(
        (error: unknown) => {
          if (missing(error)) return undefined;
          throw error;
        },
      );
      if (history?.size) listed.push({ ...record, modified: history.mtimeMs });
      else if (record.draft || record.queue?.length)
        listed.push({
          ...record,
          modified: (await stat(recordPath(directory))).mtimeMs,
        });
    }
    return listed.sort((a, b) => b.modified - a.modified);
  }

  /**
   * the prompts sent in `cwd`, newest first, skipping a line a crash cut short. a line sent from a directory that has
   * since moved here counts, matched by its byte offset against when each move was recorded.
   */
  async prompts(cwd: string): Promise<string[]> {
    const content = await readFile(this.promptsPath()).catch(
      (error: unknown) => {
        if (missing(error)) return Buffer.alloc(0);
        throw error;
      },
    );
    // an unreadable ledger leaves exact matching
    const ledger = await readLedger(this.root).catch(() => undefined);
    const { map } = ledger
      ? await mapper(ledger)
      : { map: (path: string) => path };
    // lines from one directory between the same two move boundaries map alike, so each pair maps once
    const boundaries = [
      ...new Set((ledger?.moves ?? []).map(({ prompts }) => prompts)),
    ].sort((a, b) => a - b);
    const mapped = new Map<string, string | undefined>();
    const destination = (cwd: string, start: number) => {
      const key = `${boundaries.filter((size) => size <= start).length}\0${cwd}`;
      if (!mapped.has(key))
        mapped.set(
          key,
          map(cwd, {
            predates: (move) => start < move.prompts,
            throughReused: true,
          }),
        );
      return mapped.get(key);
    };
    const prompts: string[] = [];
    for (let start = 0; start < content.length;) {
      const end = content.indexOf(10, start);
      const next = end < 0 ? content.length : end + 1;
      try {
        const prompt = promptSchema.parse(
          JSON.parse(content.toString('utf8', start, next)),
        );
        if ((destination(prompt.cwd, start) ?? prompt.cwd) === cwd)
          prompts.push(prompt.text);
      } catch {
        // a torn or foreign line isn't a prompt
      }
      start = next;
    }
    return prompts.reverse();
  }

  /**
   * waits for the prompts added before it, so the file keeps their order, and starts with the line break, so a line a
   * crash cut short ends before it.
   */
  addPrompt(cwd: string, text: string): Promise<void> {
    const line = { cwd, text: unnumbered(text) };
    const added = this.adding.then(async () => {
      const file = await open(this.promptsPath(), 'a', 0o600);
      try {
        // one write call, which other instances' appends never split; appendFile writes 512 KiB at a time
        await file.write(Buffer.from(`\n${JSON.stringify(line)}`));
      } finally {
        await file.close();
      }
    });
    this.adding = added.catch(() => {});
    return added;
  }

  /**
   * rewrites a closed conversation's raw `state.json` under its lock, without the recovery `claim` does, keeping the
   * fields its schema doesn't know and its times. `change` returns the new record, or undefined to leave it.
   */
  async repairRecord(
    id: string,
    change: (
      raw: Record<string, unknown>,
      directory: string,
    ) => Promise<Record<string, unknown> | undefined>,
  ): Promise<'repaired' | 'unchanged'> {
    const directory = this.directory(id);
    const unlock = await hold(directory);
    try {
      const file = recordPath(directory);
      const { atime, mtime } = await stat(file);
      const record = await change(
        JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>,
        directory,
      );
      if (!record) return 'unchanged';
      await replaceFile(file, `${JSON.stringify(record, null, 2)}\n`, {
        atime,
        mtime,
      });
      return 'repaired';
    } finally {
      await unlock();
    }
  }

  /** locks before writing `state.json`, so `records()` never lists an unlocked new conversation. */
  async create(conversation: Conversation): Promise<ConversationStore> {
    const directory = this.directory(conversation.id);
    await mkdir(directory, { mode: 0o700 });
    const unlock = await hold(directory);
    const files = new ConversationStore(directory, unlock, conversation);
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
    const unlock = await hold(directory);
    try {
      const record = await readRecord(directory);
      const files = new ConversationStore(directory, unlock, record);
      if (
        record.shell ||
        record.process ||
        record.usageProcess ||
        record.answerProcess
      ) {
        // the shell goes first, so a CLI that won't stop still leaves the command killed
        if (record.shell) await stopPreviousShell(record.shell);
        const stopped = await Promise.allSettled(
          [record.process, record.usageProcess, record.answerProcess].flatMap(
            (identity) => (identity ? [stopPreviousProcess(identity)] : []),
          ),
        );
        for (const result of stopped)
          if (result.status === 'rejected') throw result.reason;
        delete record.shell;
        delete record.process;
        delete record.usageProcess;
        delete record.answerProcess;
        await files.save(record);
      }
      return files;
    } catch (error) {
      await unlock();
      throw error;
    }
  }

  /** observes ownership without creating a lock or recovering native processes. */
  async isOpen(id: string): Promise<boolean> {
    return (await this.openConversations([id])).has(id);
  }

  async openConversations(
    ids?: readonly string[],
    options: { timeout?: number } = {},
  ): Promise<Map<string, { coordinated: boolean }>> {
    ids ??= await readdir(conversationsPath(this.root));
    const paths = ids.map((id) => join(this.directory(id), 'lock'));
    const locked = await lockedFiles(paths, options);
    const open = new Map<string, { coordinated: boolean }>();
    for (const [index, path] of paths.entries()) {
      const mode = locked.get(path);
      if (mode) open.set(ids[index]!, { coordinated: mode === 'shared' });
    }
    return open;
  }

  private directory(id: string): string {
    return join(conversationsPath(this.root), id);
  }

  private promptsPath(): string {
    return join(this.root, 'prompts.jsonl');
  }
}

interface PendingHistory {
  update: DisplayUpdate;
  release: () => void;
  written: Promise<void>;
  timer: ReturnType<typeof setTimeout>;
}

export class ConversationStore {
  private queue: Promise<unknown> = Promise.resolve();
  private failure?: Error;
  private historyFile?: FileHandle;
  private pending?: PendingHistory;
  private released = false;
  // kept out of `queue`, whose first failure ends every later write, so a failed save can be retried
  private readonly savingImages = new Set<Promise<unknown>>();

  constructor(
    readonly directory: string,
    private readonly unlock: () => Promise<void>,
    readonly record: ConversationRecord,
  ) {}

  get closed(): boolean {
    return this.released;
  }

  /** the absolute path of a new image file in the conversation, private like the rest of its state. */
  async saveImage(bytes: Buffer, extension: string): Promise<string> {
    if (this.released) throw new Error('This conversation is no longer open.');
    const directory = join(this.directory, 'images');
    const file = join(directory, `${randomUUID()}.${extension}`);
    const saving = mkdir(directory, { recursive: true, mode: 0o700 }).then(() =>
      writeFile(file, bytes, { mode: 0o600 }),
    );
    this.savingImages.add(saving);
    try {
      await saving;
    } finally {
      this.savingImages.delete(saving);
    }
    return file;
  }

  save(record: ConversationRecord): Promise<void> {
    const captured = JSON.parse(JSON.stringify(record)) as ConversationRecord;
    this.drainHistory();
    return this.enqueue(() => writeJson(recordPath(this.directory), captured));
  }

  append(update: DisplayUpdate): Promise<void> {
    const captured = JSON.parse(JSON.stringify(update)) as DisplayUpdate;
    if (
      (captured.kind !== 'assistant' && captured.kind !== 'tool') ||
      this.released ||
      this.failure
    ) {
      this.drainHistory();
      return this.enqueue(() => this.writeHistory(captured));
    }
    if (
      this.pending &&
      (this.pending.update.id !== captured.id ||
        this.pending.update.kind !== captured.kind)
    )
      this.drainHistory();
    if (this.pending) {
      const previous = this.pending.update;
      this.pending.update = {
        ...foldDisplayUpdates([previous, captured])[0]!,
        replace: previous.replace || captured.replace,
      };
    } else {
      const ready = Promise.withResolvers<void>();
      const pending: PendingHistory = {
        update: captured,
        release: ready.resolve,
        written: this.enqueue(async () => {
          await ready.promise;
          await this.writeHistory(pending.update);
        }),
        timer: setTimeout(() => this.drainHistory(), 100),
      };
      this.pending = pending;
    }
    const { written } = this.pending;
    if (captured.replace || captured.done) this.drainHistory();
    return written;
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
    this.drainHistory();
    await this.queue;
    if (this.failure) throw this.failure;
    await this.historyFile?.sync();
  }

  async close(): Promise<void> {
    if (this.released) return;
    this.released = true;
    try {
      await Promise.allSettled(this.savingImages);
      await this.flush();
    } finally {
      try {
        await this.historyFile?.close();
      } finally {
        this.historyFile = undefined;
        await this.unlock();
      }
    }
  }

  private drainHistory(): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    clearTimeout(pending.timer);
    pending.release();
  }

  private async writeHistory(update: DisplayUpdate): Promise<void> {
    const file = await this.openHistory();
    await file.writeFile(`${JSON.stringify(update)}\n`);
  }

  private async openHistory(): Promise<FileHandle> {
    if (this.historyFile) return this.historyFile;
    const file = await open(historyPath(this.directory), 'a+', 0o600);
    try {
      const { size } = await file.stat();
      const buffer = Buffer.alloc(Math.min(4096, size));
      let end = size;
      let length = Math.min(1, size);
      while (end) {
        const start = end - length;
        let read = 0;
        while (read < length) {
          const { bytesRead } = await file.read(
            buffer,
            read,
            length - read,
            start + read,
          );
          if (!bytesRead) break;
          read += bytesRead;
        }
        const newline = buffer.subarray(0, read).lastIndexOf(10);
        if (newline >= 0) {
          const complete = start + newline + 1;
          if (complete < size) await file.truncate(complete);
          break;
        }
        end = start;
        length = Math.min(buffer.length, end);
        if (!end) await file.truncate(0);
      }
      this.historyFile = file;
      return file;
    } catch (error) {
      await file.close();
      throw error;
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
