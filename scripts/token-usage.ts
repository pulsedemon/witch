// reports token use and spend from Claude Code and Codex logs since a local date, by model, role, day and session.
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { jsonl, lines } from './jsonl.js';

const { values } = parseArgs({ options: { since: { type: 'string' } } });
const fortnight = new Date();
fortnight.setDate(fortnight.getDate() - 14);

const since = values.since
  ? new Date(`${values.since}T00:00`).getTime()
  : fortnight.setHours(0, 0, 0, 0);

if (Number.isNaN(since)) throw new Error('--since takes YYYY-MM-DD');

// the first words of Witch's bootstrap prompt, sent only as a main session's first prompt
const bootstrap = 'You are running inside Witch.';

const roles = [
  'main',
  'familiar',
  'native subagent',
  'guardian',
  'outside Witch',
  'unattributed',
] as const;

type Role = (typeof roles)[number];

/** Claude's input and cache fields are disjoint; Codex input is normalized to match before it gets here. */
interface Tokens {
  requests: number;
  uncached: number;
  write: number;
  read: number;
  /** includes thinking or reasoning. */
  output: number;
  thinking: number;
}

const columns = ['uncached', 'write', 'read', 'output'] as const;

function zero(): Tokens {
  return {
    requests: 0,
    uncached: 0,
    write: 0,
    read: 0,
    output: 0,
    thinking: 0,
  };
}

function tally<K>(map: Map<K, Tokens>, key: K, tokens: Tokens): void {
  if (!map.has(key)) map.set(key, zero());

  const into = map.get(key)!;
  into.requests += tokens.requests;
  into.thinking += tokens.thinking;

  for (const column of columns) into[column] += tokens[column];
}

interface Session {
  runtime: 'claude' | 'codex';
  id: string;
  cwd?: string;
  role: Role;
  title?: string;
  /** total input of the session's first request, when it falls in the window. */
  first?: number;
  /** in-window tokens by model. */
  models: Map<string, Tokens>;
  /** Claude Code's whole-session estimate, for sessions started in the window. */
  usd?: number;
}

const sessions: Session[] = [];
const days = new Map<string, Tokens>();

function day(timestamp: string, runtime: string): string {
  return `${new Date(timestamp).toLocaleDateString('en-CA')} ${runtime}`;
}

/** text of a message's string content or first text block. */
function opening(content: unknown): string | undefined {
  if (typeof content === 'string') return content;

  const [block] = Array.isArray(content) ? content : [];

  return block?.type === 'text' || block?.type === 'input_text'
    ? block.text
    : undefined;
}

async function* recent(dir: string): AsyncGenerator<string> {
  for await (const file of jsonl(dir))
    if ((await stat(file)).mtimeMs >= since) yield file;
}

interface ClaudeUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
  output_tokens_details?: { thinking_tokens?: number };
}

interface ModelUsage {
  inputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  outputTokens?: number;
}

interface ClaudeRow {
  type?: string;
  entrypoint?: string;
  cwd?: string;
  timestamp?: string;
  aiTitle?: string;
  message?: {
    id?: string;
    model?: string;
    content?: unknown;
    usage?: ClaudeUsage;
  };
  startTime?: number;
  totalCostUSD?: number;
  hasUnknownModelCost?: boolean;
  modelUsage?: Record<string, ModelUsage>;
}

/** a Claude session's last cost-state and its whole-life transcript sums, which include its subagents. */
interface Lifetime {
  cost?: ClaudeRow;
  models: Map<string, Tokens>;
}

const lifetimes = new Map<string, Lifetime>();

function lifetime(id: string): Lifetime {
  if (!lifetimes.has(id)) lifetimes.set(id, { models: new Map() });

  return lifetimes.get(id)!;
}

function claudeTokens(usage: ClaudeUsage): Tokens {
  return {
    requests: 1,
    uncached: usage.input_tokens ?? 0,
    write: usage.cache_creation_input_tokens ?? 0,
    read: usage.cache_read_input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    thinking: usage.output_tokens_details?.thinking_tokens ?? 0,
  };
}

async function claude(file: string): Promise<void> {
  const subagent = basename(dirname(file)) === 'subagents';

  const id = subagent
    ? basename(dirname(dirname(file)))
    : basename(file, '.jsonl');

  const session: Session = {
    runtime: 'claude',
    id: subagent ? `${id}/${basename(file, '.jsonl')}` : id,
    role: subagent ? 'native subagent' : 'unattributed',
    models: new Map(),
  };

  let answered = false;
  let entrypoint: string | undefined;
  let main = false;
  // a response repeats once per content block, and a subagent's first copy can be a streaming snapshot
  const responses = new Map<string, ClaudeRow>();

  for await (const row of lines<ClaudeRow>(
    file,
    (line) =>
      line.includes('"type":"assistant"') ||
      line.includes('"type":"cost-state"') ||
      line.includes('"type":"ai-title"') ||
      (!answered && line.includes('"type":"user"')),
  )) {
    entrypoint ??= row.entrypoint;
    session.cwd ??= row.cwd;

    if (row.type === 'user')
      main ||= opening(row.message?.content)?.startsWith(bootstrap) ?? false;
    else if (row.type === 'ai-title') session.title = row.aiTitle;
    else if (row.type === 'cost-state') lifetime(id).cost = row;
    else if (row.type === 'assistant' && row.message?.id) {
      answered = true;
      const kept = responses.get(row.message.id);

      if (
        !kept ||
        (row.message.usage?.output_tokens ?? 0) >
          (kept.message!.usage?.output_tokens ?? 0)
      )
        responses.set(row.message.id, row);
    }
  }

  if (!subagent)
    session.role = main
      ? 'main'
      : entrypoint === 'sdk-ts' || entrypoint === 'sdk-cli'
        ? 'familiar'
        : entrypoint === 'cli'
          ? 'outside Witch'
          : 'unattributed';

  let first = true;

  for (const { message, timestamp } of responses.values()) {
    if (!message?.usage || message.model === '<synthetic>') continue;

    const tokens = claudeTokens(message.usage);
    tally(lifetime(id).models, message.model!, tokens);

    if (Date.parse(timestamp!) >= since) {
      if (first) session.first = tokens.uncached + tokens.write + tokens.read;

      tally(session.models, message.model!, tokens);
      tally(days, day(timestamp!, 'claude'), tokens);
    }

    first = false;
  }

  sessions.push(session);
}

interface CodexUsage {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens?: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

interface CodexRow {
  timestamp: string;
  type: string;
  payload: {
    type?: string;
    id?: string;
    cwd?: string;
    originator?: string;
    source?: { subagent?: { other?: string; thread_spawn?: unknown } };
    model?: string;
    role?: string;
    content?: unknown;
    usage?: CodexUsage;
    rate_limits?: { credits?: { has_credits?: boolean; balance?: string } };
  };
}

interface Reading {
  at: string;
  balance: number;
}

const credits: { first?: Reading; lowest?: Reading; last?: Reading } = {};

function codexTokens(usage: CodexUsage): Tokens {
  return {
    requests: 1,
    // Codex input includes its cached and written tokens
    uncached:
      usage.input_tokens -
      usage.cached_input_tokens -
      (usage.cache_write_input_tokens ?? 0),
    write: usage.cache_write_input_tokens ?? 0,
    read: usage.cached_input_tokens,
    output: usage.output_tokens,
    thinking: usage.reasoning_output_tokens,
  };
}

function credit(row: CodexRow): void {
  const reading = row.payload.rate_limits?.credits;

  // `premium` limits report has_credits false with a zero balance
  if (!reading?.has_credits || Date.parse(row.timestamp) < since) return;

  const read = { at: row.timestamp, balance: Number(reading.balance) };

  if (!credits.first || read.at < credits.first.at) credits.first = read;

  if (!credits.last || read.at > credits.last.at) credits.last = read;

  if (!credits.lowest || read.balance < credits.lowest.balance)
    credits.lowest = read;
}

async function codex(file: string): Promise<void> {
  let meta: CodexRow['payload'] | undefined;
  let model = '?';
  let answered = false;
  let main = false;

  const session: Session = {
    runtime: 'codex',
    id: '',
    role: 'unattributed',
    models: new Map(),
  };

  for await (const row of lines<CodexRow>(
    file,
    (line) =>
      line.includes('"type":"token_usage_record"') ||
      line.includes('"type":"turn_context"') ||
      line.includes('"type":"token_count"') ||
      (!meta && line.includes('"type":"session_meta"')) ||
      (!answered && line.includes('"role":"user"')),
  )) {
    const { payload } = row;

    // a fork copies its parent's session_meta after its own
    if (row.type === 'session_meta') meta ??= payload;
    else if (row.type === 'turn_context') model = payload.model ?? model;
    else if (payload.type === 'token_count') credit(row);
    else if (payload.role === 'user')
      main ||= opening(payload.content)?.startsWith(bootstrap) ?? false;
    else if (row.type === 'token_usage_record' && payload.usage) {
      const tokens = codexTokens(payload.usage);
      const inside = Date.parse(row.timestamp) >= since;

      if (!answered && inside) session.first = payload.usage.input_tokens;

      answered = true;

      if (inside) {
        tally(session.models, model, tokens);
        tally(days, day(row.timestamp, 'codex'), tokens);
      }
    }
  }

  const subagent = meta?.source?.subagent;
  session.id = meta?.id ?? basename(file);
  session.cwd = meta?.cwd;

  session.role =
    subagent?.other === 'guardian'
      ? 'guardian'
      : subagent?.thread_spawn
        ? 'native subagent'
        : main
          ? 'main'
          : meta?.originator === 'witch'
            ? 'familiar'
            : meta
              ? 'outside Witch'
              : 'unattributed';

  sessions.push(session);
}

const started = Date.now();

for await (const file of recent(join(homedir(), '.claude', 'projects')))
  await claude(file);

for await (const file of recent(join(homedir(), '.codex', 'sessions')))
  await codex(file);

/** Claude Code's model keys can carry a context suffix such as `[1m]` that transcripts leave off. */
function model(key: string): string {
  return key.replace(/\[[^\]]*\]$/, '');
}

const residuals = new Map<string, Tokens>();
let behind = 0;
let unknownCost = 0;

for (const session of sessions) {
  if (session.runtime !== 'claude' || session.role === 'native subagent')
    continue;

  const { cost, models } = lifetimes.get(session.id) ?? { models: new Map() };

  if (!cost?.modelUsage || (cost.startTime ?? 0) < since) continue;

  session.usd = cost.totalCostUSD;
  unknownCost += cost.hasUnknownModelCost ? 1 : 0;
  let negative = false;

  for (const [key, usage] of Object.entries(cost.modelUsage)) {
    const seen = models.get(model(key)) ?? zero();

    const left: Tokens = {
      ...zero(),
      uncached: (usage.inputTokens ?? 0) - seen.uncached,
      write: (usage.cacheCreationInputTokens ?? 0) - seen.write,
      read: (usage.cacheReadInputTokens ?? 0) - seen.read,
      output: (usage.outputTokens ?? 0) - seen.output,
    };

    negative ||= columns.some((column) => left[column] < 0);

    for (const column of columns) left[column] = Math.max(0, left[column]);

    if (columns.some((column) => left[column] > 0))
      tally(residuals, model(key), { ...left, requests: 1 });
  }

  behind += negative ? 1 : 0;
}

const compact = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

const count = (value: number) => compact.format(value);

const percent = (part: number, whole: number) =>
  whole ? `${Math.round((part / whole) * 100)}%` : '-';

const usd = (value: number) => `$${value.toFixed(2)}`;

function print(title: string, head: string[], rows: string[][]): void {
  const widths = head.map((cell, column) =>
    Math.max(cell.length, ...rows.map((row) => row[column]!.length)),
  );

  // numbers, amounts and timestamps align right; labels, paths and titles align left
  const right = head.map(
    (_, column) =>
      column > 0 && rows.every((row) => /^[-$\d]/.test(row[column]!)),
  );

  const line = (row: string[]) =>
    row
      .map((cell, column) =>
        right[column]
          ? cell.padStart(widths[column]!)
          : cell.padEnd(widths[column]!),
      )
      .join('  ')
      .trimEnd();

  console.log(`\n${title}\n${line(head)}`);

  for (const row of rows) console.log(line(row));
}

const tokenHead = [
  'requests',
  'uncached',
  'cache write',
  'cache read',
  'output',
  'thinking',
  'hit',
];

function tokenCells(tokens: Tokens): string[] {
  return [
    count(tokens.requests),
    ...columns.map((column) => count(tokens[column])),
    percent(tokens.thinking, tokens.output),
    percent(tokens.read, tokens.uncached + tokens.write + tokens.read),
  ];
}

const byModel = new Map<string, Tokens>();
const byRole = new Map<string, Tokens>();

for (const session of sessions)
  for (const [name, tokens] of session.models) {
    tally(byModel, `${session.runtime} ${name}`, tokens);
    tally(byRole, `${session.runtime} ${session.role}`, tokens);
  }

const sorted = <K>(map: Map<K, Tokens>) =>
  [...map].sort(([a], [b]) => String(a).localeCompare(String(b)));

console.log(
  `token usage since ${new Date(since).toLocaleDateString('en-CA')}, read in ${Math.round((Date.now() - started) / 1000)}s`,
);

print(
  'by runtime and model',
  ['model', ...tokenHead],
  sorted(byModel).map(([name, tokens]) => [name, ...tokenCells(tokens)]),
);

print(
  'by role',
  ['role', ...tokenHead],
  sorted(byRole).map(([name, tokens]) => [name, ...tokenCells(tokens)]),
);

console.log("\noutside Witch includes Witch's own probe rollouts.");
const priced = sessions.filter((session) => session.usd !== undefined);

print(
  "Claude USD, Claude Code's API-price estimate for whole sessions started in the window",
  ['role', 'sessions', 'USD'],
  roles
    .map((role) => priced.filter((session) => session.role === role))
    .filter((group) => group.length)
    .map((group) => [
      group[0]!.role,
      String(group.length),
      usd(group.reduce((sum, session) => sum + session.usd!, 0)),
    ]),
);

print(
  'Claude usage not in transcripts, cause unverified',
  ['model', 'sessions', ...columns],
  sorted(residuals).map(([name, tokens]) => [
    name,
    String(tokens.requests),
    ...columns.map((column) => count(tokens[column])),
  ]),
);

console.log(
  `\nUSD is understated for sessions whose last cost-state predates their last response (${behind}) or that used a model without a known price (${unknownCost}).`,
);

function quantile(sorted: number[], q: number): string {
  return sorted.length
    ? count(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!)
    : '-';
}

print(
  'first-request input, including instructions, memory and the task',
  ['role', 'sessions', 'median', 'p90'],
  ['claude', 'codex'].flatMap((runtime) =>
    roles.flatMap((role) => {
      const firsts = sessions
        .filter(
          (session) =>
            session.runtime === runtime &&
            session.role === role &&
            session.first !== undefined,
        )
        .map((session) => session.first!)
        .sort((a, b) => a - b);

      return firsts.length
        ? [
            [
              `${runtime} ${role}`,
              String(firsts.length),
              quantile(firsts, 0.5),
              quantile(firsts, 0.9),
            ],
          ]
        : [];
    }),
  ),
);

print(
  'per local day',
  ['day', ...tokenHead],
  sorted(days).map(([name, tokens]) => [name, ...tokenCells(tokens)]),
);

const total = (session: Session) =>
  [...session.models.values()].reduce(
    (sum, tokens) =>
      sum + tokens.uncached + tokens.write + tokens.read + tokens.output,
    0,
  );

const where = (session: Session) =>
  session.cwd?.replace(homedir() + sep, '~/') ?? '';

print(
  'top Claude sessions by USD',
  ['session', 'role', 'USD', 'cwd', 'title'],
  priced
    .sort((a, b) => b.usd! - a.usd!)
    .slice(0, 15)
    .map((session) => [
      session.id,
      session.role,
      usd(session.usd!),
      where(session),
      session.title ?? '',
    ]),
);

print(
  'top Codex sessions by tokens',
  ['session', 'role', 'tokens', 'cwd'],
  sessions
    .filter((session) => session.runtime === 'codex')
    .sort((a, b) => total(b) - total(a))
    .slice(0, 15)
    .map((session) => [
      session.id,
      session.role,
      count(total(session)),
      where(session),
    ]),
);

const { first, lowest, last } = credits;

if (first && lowest && last)
  print(
    'Codex credits beyond plan quota, account-wide',
    ['reading', 'at', 'balance'],
    [
      ['first', first.at, first.balance.toFixed(2)],
      ['lowest', lowest.at, lowest.balance.toFixed(2)],
      ['last', last.at, last.balance.toFixed(2)],
      ['spent', '', (first.balance - lowest.balance).toFixed(2)],
    ],
  );
