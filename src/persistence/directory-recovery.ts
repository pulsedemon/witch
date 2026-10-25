import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  utimes,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { z } from 'zod';
import { errorMessage } from '../agents/stderr.js';
import {
  conversationRecordSchema,
  displayUpdateSchema,
} from '../core/state.js';
import type { ConversationRecord } from '../core/state.js';
import type { Memory } from '../memory/memory.js';
import { quote } from '../shell.js';
import { writeJson } from './json.js';
import { identifyProcesses, sameProcess } from './process.js';
import { promptSchema } from './store.js';
import type { StateStore } from './store.js';

const journalName = 'directory-recovery.json';
const reportSchema = z.object({
  source: z.string(),
  destination: z.string(),
  conversations: z.number().int().nonnegative(),
  histories: z.number().int().nonnegative(),
  prompts: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  sourceProjects: z.array(z.string()),
  unknownProjectRecords: z.number().int().nonnegative(),
  destinationProject: z.string(),
  blockers: z.array(z.string()),
  applied: z.boolean(),
  backup: z.string().optional(),
});

export type DirectoryRecoveryReport = z.infer<typeof reportSchema>;

const targetPath = z.string().refine((path) => {
  const parts = path.split('/');
  return (
    !path.includes('\0') &&
    (path === 'prompts.jsonl' ||
      (parts.length === 3 &&
        parts[0] === 'conversations' &&
        parts[1] !== '' &&
        parts[1] !== '.' &&
        parts[1] !== '..' &&
        ['state.json', 'history.jsonl'].includes(parts[2]!)))
  );
}, 'Recovery targets must be conversation state, display history or prompt history.');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const journalSchema = z.object({
  version: z.literal(1),
  id: z.uuid(),
  report: reportSchema.omit({ blockers: true, applied: true, backup: true }),
  files: z.array(
    z.object({
      path: targetPath,
      before: digest,
      after: digest,
      atime: z.number().finite(),
      mtime: z.number().finite(),
    }),
  ),
});
type Journal = z.infer<typeof journalSchema>;
interface PreparedFile {
  path: string;
  content: Buffer;
  replacement: Buffer;
  atime: number;
  mtime: number;
}

function absent(error: unknown): boolean {
  return ['ENOENT', 'ENOTDIR'].includes(
    (error as NodeJS.ErrnoException).code ?? '',
  );
}

function hash(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

async function pending(root: string): Promise<Journal | undefined> {
  const content = await readFile(join(root, journalName), 'utf8').catch(
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return undefined;
    },
  );
  return content === undefined
    ? undefined
    : journalSchema.parse(JSON.parse(content));
}

function command(root: string, source: string, destination: string): string {
  return `cd ${quote(destination)} && witch --state-dir ${quote(root)} --recover-directory ${quote(source)} --apply`;
}

export async function assertNoPendingDirectoryRecovery(
  root: string,
): Promise<void> {
  const journal = await pending(root);
  if (journal)
    throw new Error(
      `Directory recovery is incomplete. Resume it with:\n${command(root, journal.report.source, journal.report.destination)}`,
    );
}

export async function missingConversationDirectories(
  store: StateStore,
): Promise<Array<{ cwd: string; conversations: number }>> {
  const groups = new Map<string, number>();
  for (const record of (await store.records()).records)
    groups.set(record.cwd, (groups.get(record.cwd) ?? 0) + 1);
  const missing: Array<{ cwd: string; conversations: number }> = [];
  for (const [cwd, conversations] of groups) {
    try {
      await stat(cwd);
    } catch (error) {
      if (!absent(error)) throw error;
      missing.push({ cwd, conversations });
    }
  }
  return missing.sort((a, b) => a.cwd.localeCompare(b.cwd));
}

function rewriteLines(
  content: Buffer,
  schema: z.ZodType<{ cwd: string }>,
  destination: (cwd: string) => string,
): { content: Buffer; count: number } {
  const parts: Buffer[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let count = 0;
  for (let start = 0; start < content.length;) {
    const newline = content.indexOf(10, start);
    const end = newline < 0 ? content.length : newline;
    const next = newline < 0 ? end : end + 1;
    const textEnd = content[end - 1] === 13 ? end - 1 : end;
    let line = content.subarray(start, next);
    try {
      const raw: unknown = JSON.parse(
        decoder.decode(content.subarray(start, textEnd)),
      );
      const checked = schema.safeParse(raw);
      if (checked.success) {
        const cwd = destination(checked.data.cwd);
        if (cwd !== checked.data.cwd) {
          line = Buffer.concat([
            Buffer.from(
              JSON.stringify({ ...(raw as Record<string, unknown>), cwd }),
            ),
            content.subarray(textEnd, next),
          ]);
          count++;
        }
      }
    } catch {
      // a torn or unreadable line stays available for the store's existing recovery rules
    }
    parts.push(line);
    start = next;
  }
  return { content: count ? Buffer.concat(parts) : content, count };
}

async function readTarget(root: string, path: string) {
  targetPath.parse(path);
  const file = join(root, path);
  if ((await realpath(dirname(file))) !== dirname(file))
    throw new Error(`Recovery cannot follow a linked state directory: ${file}`);
  const info = await lstat(file);
  if (!info.isFile())
    throw new Error(`Recovery requires a regular file: ${file}`);
  return {
    path,
    content: await readFile(file),
    atime: info.atimeMs,
    mtime: info.mtimeMs,
  };
}

async function admission(
  store: StateStore,
  memory: Memory,
  source: string,
  destination: string,
  records: ConversationRecord[],
) {
  const scopes = records.map((record) =>
    Object.values(record.sessions).flatMap((session) =>
      session.deliveredProject ? [session.deliveredProject] : [],
    ),
  );
  const report = {
    sourceProjects: [...new Set(scopes.flat())].sort(),
    unknownProjectRecords: scopes.filter((scope) => !scope.length).length,
    destinationProject: (await memory.scopePaths(destination)).project,
    blockers: [] as string[],
  };
  try {
    await stat(source);
    report.blockers.push(`The source directory still exists: ${source}`);
  } catch (error) {
    if (!absent(error)) report.blockers.push(errorMessage(error));
  }
  if (
    report.sourceProjects.some(
      (project) => project !== report.destinationProject,
    )
  )
    report.blockers.push(
      'The saved project memory scope differs from the destination. Resolve the project mapping before recovery.',
    );
  const open = await store.openConversations();
  if (open.size)
    report.blockers.push(
      `${open.size} conversation(s) are open. Close all Witches using this state directory before applying recovery.`,
    );
  const identities = records.flatMap(({ process, usageProcess, shell }) =>
    [process, usageProcess, shell].filter((identity) => identity !== undefined),
  );
  const running = await identifyProcesses(identities.map(({ pid }) => pid));
  if (
    identities.some((identity) =>
      sameProcess(running.get(identity.pid), identity),
    )
  )
    report.blockers.push(
      'An affected native process or shell is still running. Wait for it to end before applying recovery.',
    );
  return report;
}

async function inventory(
  store: StateStore,
  memory: Memory,
  root: string,
  source: string,
  destination: string,
): Promise<{ report: DirectoryRecoveryReport; files: PreparedFile[] }> {
  const { records, unreadable } = await store.records();
  const selected = records.filter(({ cwd }) => cwd === source);
  const report: DirectoryRecoveryReport = {
    ...(await admission(store, memory, source, destination, selected)),
    source,
    destination,
    conversations: selected.length,
    histories: 0,
    prompts: 0,
    bytes: 0,
    applied: false,
  };
  report.blockers.push(
    ...unreadable.map(({ file, error }) => `${file}: ${error}`),
  );
  const files: PreparedFile[] = [];
  const collect = async (
    path: string,
    kind: 'state' | 'history' | 'prompts',
  ) => {
    try {
      const original = await readTarget(root, path);
      let replacement: Buffer;
      if (kind === 'state') {
        const raw: unknown = JSON.parse(original.content.toString('utf8'));
        if (conversationRecordSchema.parse(raw).cwd !== source)
          throw new Error(
            `Conversation changed while reading recovery preview: ${path}`,
          );
        replacement = Buffer.from(
          `${JSON.stringify({ ...(raw as Record<string, unknown>), cwd: destination }, null, 2)}\n`,
        );
      } else {
        const rewritten = rewriteLines(
          original.content,
          kind === 'prompts' ? promptSchema : displayUpdateSchema,
          (cwd) =>
            cwd === source
              ? destination
              : kind === 'history' && cwd.startsWith(`${source}${sep}`)
                ? `${destination}${cwd.slice(source.length)}`
                : cwd,
        );
        replacement = rewritten.content;
        if (kind === 'prompts') report.prompts = rewritten.count;
        else if (original.content.length) report.histories++;
      }
      if (!original.content.equals(replacement))
        files.push({ ...original, replacement });
    } catch (error) {
      if (
        kind !== 'state' &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      )
        return;
      report.blockers.push(errorMessage(error));
    }
  };
  for (const { id } of selected) {
    await collect(`conversations/${id}/state.json`, 'state');
    await collect(`conversations/${id}/history.jsonl`, 'history');
  }
  await collect('prompts.jsonl', 'prompts');
  report.bytes = files.reduce((total, file) => total + file.content.length, 0);
  return { report, files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}

async function writePrepared(file: string, content: Buffer): Promise<void> {
  const handle = await open(file, 'wx', 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function prepare(
  root: string,
  report: DirectoryRecoveryReport,
  files: PreparedFile[],
): Promise<Journal> {
  const id = randomUUID();
  const parent = join(root, 'recoveries');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if ((await realpath(parent)) !== parent)
    throw new Error(
      `Recovery cannot follow a linked backup directory: ${parent}`,
    );
  const backup = join(parent, id);
  await mkdir(backup, { mode: 0o700 });
  const journal = journalSchema.parse({
    version: 1,
    id,
    report,
    files: files.map((file) => ({
      path: file.path,
      before: hash(file.content),
      after: hash(file.replacement),
      atime: file.atime,
      mtime: file.mtime,
    })),
  });
  for (const [index, file] of files.entries()) {
    await writePrepared(join(backup, `${index}.original`), file.content);
    await writePrepared(join(backup, `${index}.prepared`), file.replacement);
  }
  await writeJson(join(backup, 'manifest.json'), journal);
  await writeJson(join(root, journalName), journal);
  return journal;
}

async function finish(
  root: string,
  journal: Journal,
): Promise<DirectoryRecoveryReport> {
  const backup = join(root, 'recoveries', journal.id);
  if ((await realpath(backup)) !== backup)
    throw new Error(
      `Recovery cannot follow a linked backup directory: ${backup}`,
    );
  for (const [index, file] of journal.files.entries()) {
    const target = join(root, file.path);
    const current = hash((await readTarget(root, file.path)).content);
    if (current !== file.after) {
      if (current !== file.before)
        throw new Error(
          `Recovery stopped because a file changed outside the migration: ${target}`,
        );
      const prepared = join(backup, `${index}.prepared`);
      if (hash(await readFile(prepared)) !== file.after)
        throw new Error(`Recovery's prepared file changed: ${prepared}`);
      await rename(prepared, target);
    }
  }
  for (const file of journal.files) {
    if (hash((await readTarget(root, file.path)).content) !== file.after)
      throw new Error(`Recovery could not verify ${join(root, file.path)}`);
    await utimes(join(root, file.path), file.atime / 1000, file.mtime / 1000);
  }
  await writeJson(join(backup, 'manifest.json'), {
    ...journal,
    completed: true,
  });
  await unlink(join(root, journalName));
  return { ...journal.report, blockers: [], applied: true, backup };
}

export async function recoverDirectory(
  store: StateStore,
  memory: Memory,
  source: string,
  destination: string,
  apply: boolean,
): Promise<DirectoryRecoveryReport> {
  if (!isAbsolute(source))
    throw new Error('Choose an absolute saved directory to recover.');
  source = normalize(source).replace(/\/$/, '') || '/';
  destination = await realpath(destination);
  const root = await realpath(store.root);
  const lock = apply ? await store.lockDirectory('exclusive') : undefined;
  try {
    const journal = await pending(root);
    if (journal) {
      if (
        source !== journal.report.source ||
        destination !== journal.report.destination
      )
        throw new Error(
          `Another directory recovery is incomplete. Resume it with:\n${command(root, journal.report.source, journal.report.destination)}`,
        );
      const ids = journal.files
        .filter(({ path }) => path.endsWith('/state.json'))
        .map(({ path }) => path.split('/')[1]!);
      const { records, unreadable } = await store.records(ids);
      const checks = await admission(
        store,
        memory,
        source,
        destination,
        records,
      );
      checks.blockers.push(
        ...unreadable.map(({ file, error }) => `${file}: ${error}`),
      );
      if (checks.destinationProject !== journal.report.destinationProject)
        checks.blockers.push(
          'The destination memory scope changed after recovery was prepared. Restore that project mapping before resuming.',
        );
      if (!apply)
        return {
          ...journal.report,
          destinationProject: checks.destinationProject,
          blockers: [
            'A previous apply is incomplete. Repeat this command with --apply to resume.',
            ...checks.blockers,
          ],
          applied: false,
          backup: join(root, 'recoveries', journal.id),
        };
      if (checks.blockers.length) throw new Error(checks.blockers.join('\n'));
      return await finish(root, journal);
    }
    const { report, files } = await inventory(
      store,
      memory,
      root,
      source,
      destination,
    );
    if (!apply || report.blockers.length) return report;
    if (!files.length) return { ...report, applied: true };
    return await finish(root, await prepare(root, report, files));
  } finally {
    await lock?.close();
  }
}
