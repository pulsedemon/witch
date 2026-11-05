// writes one grading packet per compaction in real Witch conversations; docs/compaction-check.md owns the procedure.
import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    state: { type: 'string', default: join(homedir(), '.witch') },
    out: { type: 'string' },
    before: { type: 'string', default: '8' },
    after: { type: 'string', default: '4' },
  },
});
assert.ok(values.out, '--out is required');
const before = Number(values.before);
const after = Number(values.after);
const out = resolve(values.out);

/** `command` is a compaction Witch ran, at its threshold or for `/compact`; `native` is the runtime's own. */
type Trigger = 'command' | 'native';

interface NativeCompaction {
  runtime: string;
  session?: string;
  at: number;
  trigger: Trigger;
  tokens?: number;
  window?: number;
  /** a Codex compaction after the turn's first output. */
  afterOutput?: boolean;
}

interface Entry {
  kind: string;
  text: string;
  /** absent on rows older than history timestamps. */
  at?: string;
  /** the runtime that wrote a reply. */
  agent?: string;
}

/** a missing file or directory reads as the fallback; any other failure stops the run. */
function absent<T>(fallback: T): (error: NodeJS.ErrnoException) => T {
  return (error) => {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  };
}

async function* jsonl(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, {
    recursive: true,
    withFileTypes: true,
  }).catch(absent([])))
    if (entry.isFile() && entry.name.endsWith('.jsonl'))
      yield join(entry.parentPath, entry.name);
}

/** the fields read from Witch history, Claude transcript and Codex rollout rows. */
interface Row {
  kind?: string;
  text?: string;
  at?: string;
  id?: string;
  title?: string;
  replace?: boolean;
  contextCleared?: boolean;
  unread?: boolean;
  entrypoint?: string;
  sessionId?: string;
  isSidechain?: boolean;
  type?: string;
  subtype?: string;
  timestamp?: string;
  compactMetadata?: { trigger?: string; preTokens?: number };
  payload?: {
    type?: string;
    id?: string;
    originator?: string;
    source?: unknown;
    role?: string;
    model_context_window?: number;
    info?: {
      last_token_usage?: { total_tokens?: number };
      model_context_window?: number;
    };
  };
}

/** parses one JSONL row; only the last row may be malformed, since a running agent can be mid-write. */
class Rows {
  private malformed?: number;
  private number = 0;

  constructor(private readonly file: string) {}

  parse(line: string): Row | undefined {
    this.number++;
    if (!line) return;
    if (this.malformed)
      throw new Error(`${this.file}:${this.malformed}: malformed JSON row`);
    try {
      return JSON.parse(line) as Row;
    } catch {
      this.malformed = this.number;
    }
  }
}

/**
 * streams a log's rows; some Codex rollouts exceed the maximum string length. rows end at `\n` only, since
 * `readline` also breaks at a U+2028 inside a row's text.
 */
async function* lines(file: string): AsyncGenerator<Row> {
  const parsed = new Rows(file);
  let rest = '';
  for await (const chunk of createReadStream(file, { encoding: 'utf8' })) {
    const split = (rest + (chunk as string)).split('\n');
    rest = split.pop()!;
    for (const line of split) {
      const row = parsed.parse(line);
      if (row) yield row;
    }
  }
  const row = parsed.parse(rest);
  if (row) yield row;
}

/**
 * Claude records a compaction Witch runs as a manual trigger. `sdk-ts` leaves out familiars, which run `claude -p`;
 * Witch's other Agent SDK queries don't persist, though another SDK app's sessions would pass.
 */
async function claudeCompactions(): Promise<NativeCompaction[]> {
  const found: NativeCompaction[] = [];
  for await (const file of jsonl(join(homedir(), '.claude', 'projects'))) {
    for await (const row of lines(file))
      if (
        row.subtype === 'compact_boundary' &&
        row.entrypoint === 'sdk-ts' &&
        !row.isSidechain
      )
        found.push({
          runtime: 'claude',
          session: row.sessionId,
          at: Date.parse(row.timestamp!),
          trigger:
            row.compactMetadata?.trigger === 'auto' ? 'native' : 'command',
          tokens: row.compactMetadata?.preTokens,
        });
  }
  return found;
}

/** response items the model produces; snapshots and tool outputs can precede any of them. */
const outputTypes = new Set([
  'agent_message',
  'reasoning',
  'function_call',
  'custom_tool_call',
  'local_shell_call',
  'web_search_call',
]);

/**
 * Witch's `thread/compact/start` runs as a turn of its own with no output; Codex's own compaction runs inside
 * a turn that has output, before or after it. Subagent and guardian threads are skipped; Witch's Codex familiars
 * share the main thread's originator and source, so matching prefers the conversation's session.
 */
async function codexCompactions(): Promise<NativeCompaction[]> {
  const found: NativeCompaction[] = [];
  for await (const file of jsonl(join(homedir(), '.codex', 'sessions'))) {
    let session: string | undefined;
    let turn: NativeCompaction[] = [];
    let output = false;
    let tokens: number | undefined;
    let window: number | undefined;
    // the usage Witch's pre-turn check read
    let start: number | undefined;
    for await (const row of lines(file)) {
      const payload = row.payload ?? {};
      if (row.type === 'session_meta') {
        if (payload.originator !== 'witch' || payload.source !== 'vscode')
          break;
        session = payload.id;
      } else if (
        payload.type === 'task_complete' ||
        payload.type === 'turn_aborted'
      ) {
        // the next prompt's input is written before its task_started
        turn = [];
        output = false;
      } else if (payload.type === 'task_started') {
        turn = [];
        output = false;
        start = tokens;
        window = payload.model_context_window ?? window;
      } else if (payload.type === 'token_count') {
        tokens = payload.info?.last_token_usage?.total_tokens ?? tokens;
        window = payload.info?.model_context_window ?? window;
      } else if (
        row.type === 'response_item' &&
        (payload.type === 'message'
          ? payload.role === 'assistant'
          : outputTypes.has(payload.type!))
      ) {
        output = true;
        for (const compaction of turn) compaction.trigger = 'native';
      } else if (row.type === 'compacted' && session) {
        const compaction: NativeCompaction = {
          runtime: 'codex',
          session,
          at: Date.parse(row.timestamp!),
          trigger: output ? 'native' : 'command',
          tokens: output ? tokens : start,
          window,
          afterOutput: output,
        };
        turn.push(compaction);
        found.push(compaction);
      }
    }
  }
  return found;
}

function rows(text: string, file: string): Row[] {
  const parsed = new Rows(file);
  return text.split('\n').flatMap((line) => parsed.parse(line) ?? []);
}

/** the conversation as the user saw it: prompts, compaction notices and the last reply before each, a replaced reply kept at its first position. */
function transcript(text: string, file: string): Entry[] {
  const entries: Entry[] = [];
  const byId = new Map<string, Entry>();
  // the queue sends an unread prompt again as a new row
  const unread = new Set<Entry>();
  for (const row of rows(text, file)) {
    const kind = row.contextCleared
      ? 'cleared'
      : row.kind === 'notice' && row.text === 'Conversation compacted'
        ? 'compaction'
        : row.kind;
    if (
      kind !== 'user' &&
      kind !== 'assistant' &&
      kind !== 'compaction' &&
      kind !== 'cleared'
    )
      continue;
    // old rows carry no time to match a compaction by
    if (!row.at && kind === 'compaction') continue;
    const known = row.id ? byId.get(row.id) : undefined;
    if (known) {
      if (row.unread) unread.add(known);
      // an update without `replace` is a streamed chunk
      known.text = row.replace
        ? (row.text ?? '')
        : known.text + (row.text ?? '');
      continue;
    }
    const entry: Entry = {
      kind,
      text: row.text ?? '',
      at: row.at,
      agent: row.kind === 'assistant' ? row.title : undefined,
    };
    if (row.id) byId.set(row.id, entry);
    entries.push(entry);
  }
  const sent = entries.filter((entry) => !unread.has(entry));
  // keep only the last reply before the next prompt or notice
  return sent.filter(
    (entry, index) =>
      entry.kind !== 'assistant' || sent[index + 1]?.kind !== 'assistant',
  );
}

function clip(text: string, limit: number): string {
  return text.length <= limit
    ? text
    : `${text.slice(0, limit)}\n[… ${text.length - limit} characters cut]`;
}

function render(entries: Entry[], limit: number): string {
  return entries
    .map(
      (entry) =>
        `### ${entry.kind === 'user' ? 'user' : 'agent'}\n\n${clip(entry.text, limit)}`,
    )
    .join('\n\n');
}

function prompts(entries: Entry[], count: number, fromEnd: boolean): Entry[] {
  const starts = entries.flatMap((entry, index) =>
    entry.kind === 'user' ? [index] : [],
  );
  if (fromEnd) {
    const first = count ? (starts.at(-count) ?? 0) : entries.length;
    return entries.slice(first);
  }
  const end = starts[count] ?? entries.length;
  return entries.slice(0, end);
}

const natives = [...(await claudeCompactions()), ...(await codexCompactions())];
const conversations = join(values.state, 'conversations');
const read = await Promise.all(
  (await readdir(conversations)).map(async (id) => {
    const file = join(conversations, id, 'history.jsonl');
    const history = await readFile(file, 'utf8').catch(absent(''));
    // only each runtime's latest session is recorded; older ones match by time alone
    const { sessions = {} } = JSON.parse(
      await readFile(join(conversations, id, 'state.json'), 'utf8').catch(
        absent('{}'),
      ),
    ) as { sessions?: Record<string, { id?: string } | undefined> };
    return { id, sessions, entries: transcript(history, file) };
  }),
);
const latest = new Set(
  read.flatMap(({ sessions }) =>
    Object.values(sessions).flatMap((session) =>
      session?.id ? [session.id] : [],
    ),
  ),
);
const notices = read.flatMap(({ id, sessions, entries }) =>
  entries.flatMap((entry, index) => {
    if (entry.kind !== 'compaction') return [];
    const next = entries.findIndex(
      (e, i) => i > index && (e.kind === 'compaction' || e.kind === 'cleared'),
    );
    const window = entries.slice(index, next === -1 ? undefined : next);
    const prompt = window.findIndex((e) => e.kind === 'user');
    // the reply after a compaction, before the next prompt can switch runtime, comes from the session that compacted
    const agent =
      window
        .slice(0, prompt === -1 ? undefined : prompt + 2)
        .find((e) => e.agent)?.agent ??
      entries.slice(0, index).findLast((e) => e.agent)?.agent;
    return [
      {
        id,
        entries,
        index,
        at: Date.parse(entry.at!),
        agent,
        current: agent ? sessions[agent]?.id : undefined,
        native: undefined as NativeCompaction | undefined,
      },
    ];
  }),
);
const matched = new Set<NativeCompaction>();
// every conversation's own session first, so a time-only match can't take another's compaction; each pass
// assigns the closest pairs first
for (const own of [true, false]) {
  const pairs = notices
    .filter((notice) => !notice.native && (!own || notice.current))
    .flatMap((notice) =>
      natives
        .filter(
          (candidate) =>
            !matched.has(candidate) &&
            candidate.runtime === notice.agent &&
            (own
              ? candidate.session === notice.current
              : !latest.has(candidate.session!)),
        )
        .map((candidate) => ({
          notice,
          candidate,
          gap: Math.abs(candidate.at - notice.at),
        }))
        .filter(({ gap }) => gap < 60_000),
    )
    .sort((a, b) => a.gap - b.gap);
  for (const { notice, candidate } of pairs)
    if (!notice.native && !matched.has(candidate)) {
      notice.native = candidate;
      matched.add(candidate);
    }
}
const cases = [];
await mkdir(join(out, 'packets'), { recursive: true });
for (const { id, entries, index, current, native } of notices) {
  // a prompt whose turn compacts is answered after the compaction; Witch writes the prompt after its own
  // compaction before a turn, so a prompt before that one belongs to an earlier turn
  const last = entries[index - 1];
  const inTurn = entries[index + 1]?.kind === 'assistant';
  const prompt =
    inTurn && last?.kind === 'user' && !last.text.startsWith('!')
      ? index - 1
      : index;
  const cleared = entries.findLastIndex(
    (e, i) => i < prompt && e.kind === 'cleared',
  );
  const earlier = entries
    .slice(cleared + 1, prompt)
    .filter((e) => e.kind !== 'compaction');
  const later = [...entries.slice(prompt, index), ...entries.slice(index + 1)];
  const next = later.findIndex(
    (e) => e.kind === 'compaction' || e.kind === 'cleared',
  );
  const following = prompts(
    next === -1 ? later : later.slice(0, next),
    after,
    false,
  );
  const name = `${id}-${index}`;
  const record = {
    name,
    conversation: id,
    at: entries[index]!.at,
    runtime: native?.runtime,
    trigger: native?.trigger,
    session: native ? native.session === current : undefined,
    afterOutput: native?.afterOutput,
    // floored, so a case just under `compactAt` doesn't read as reaching it
    percent:
      native?.tokens && native.window
        ? Math.floor((100 * native.tokens) / native.window)
        : undefined,
    tokens: native?.tokens,
    promptsAfter: following.filter((e) => e.kind === 'user').length,
  };
  cases.push(record);
  await writeFile(
    join(out, 'packets', `${name}.md`),
    [
      // runtime and trigger stay in cases.json so the grader is blind to them
      `# ${name}`,
      '## conversation opening',
      render(prompts(earlier, 2, false), 3000),
      '## before compaction',
      render(prompts(earlier, before, true), 2000),
      '## after compaction',
      render(following, 4000),
    ].join('\n\n'),
  );
}
await writeFile(join(out, 'cases.json'), JSON.stringify(cases, null, 2));
const groups = Map.groupBy(
  cases,
  (c) => `${c.runtime ?? 'unmatched'} ${c.trigger ?? ''}`,
);
for (const [group, members] of groups) {
  const percents = members
    .map((c) => c.percent)
    .filter((p) => p !== undefined)
    .sort((a, b) => a - b);
  console.log(
    `${group}: ${members.length} cases, ${members.filter((c) => c.session).length} in the conversation's latest session, ${members.filter((c) => c.promptsAfter >= 2).length} with 2+ prompts after` +
      (percents.length
        ? `, context ${percents[0]}-${percents.at(-1)}% (median ${(percents[(percents.length - 1) >> 1]! + percents[percents.length >> 1]!) / 2})`
        : ''),
  );
}
