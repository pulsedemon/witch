import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'vitest';
import { scratch } from '../fixtures/scratch.js';

const execute = promisify(execFile);

const script = fileURLToPath(
  new URL('../../scripts/token-usage.ts', import.meta.url),
);

const inside = (hour: number) =>
  `2026-11-20T${String(hour).padStart(2, '0')}:00:00.000Z`;

const before = '2026-11-01T00:00:00.000Z';
const bootstrap = 'You are running inside Witch. Witch calls native skills';

async function jsonl(file: string, rows: readonly unknown[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n'));
}

function assistant(
  id: string,
  model: string,
  usage: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: 'assistant',
    timestamp: inside(10),
    message: { id, model, usage },
  };
}

const meta = (id: string, source: unknown) => ({
  timestamp: inside(9),
  type: 'session_meta',
  payload: { id, cwd: '/work', originator: 'witch', source },
});

const context = (model: string) => ({
  timestamp: inside(9),
  type: 'turn_context',
  payload: { model },
});

const record = (
  timestamp: string,
  input: number,
  cached: number,
  output: number,
  reasoning = 0,
) => ({
  timestamp,
  type: 'token_usage_record',
  payload: {
    usage: {
      input_tokens: input,
      cached_input_tokens: cached,
      cache_write_input_tokens: 0,
      output_tokens: output,
      reasoning_output_tokens: reasoning,
    },
  },
});

const balance = (hour: number, value: string, limit = 'codex') => ({
  timestamp: inside(hour),
  type: 'event_msg',
  payload: {
    type: 'token_count',
    rate_limits: {
      limit_id: limit,
      credits: { has_credits: limit === 'codex', balance: value },
    },
  },
});

const user = (text: string) => ({
  timestamp: inside(9),
  type: 'response_item',
  payload: {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }],
  },
});

/** one home holding every case, so the script runs once for all tests. */
async function home(): Promise<string> {
  const root = await scratch('token-usage-');
  const claude = join(root, '.claude', 'projects', '-work');
  const codex = join(root, '.codex', 'sessions');

  await jsonl(join(claude, 'main.jsonl'), [
    {
      type: 'user',
      entrypoint: 'sdk-ts',
      cwd: '/work',
      message: { role: 'user', content: '<command-name>/model</command-name>' },
    },
    {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: bootstrap }] },
    },
    // a streaming snapshot, then the response's final usage
    assistant('a1', 'claude-o', {
      input_tokens: 1,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 1000,
      output_tokens: 8,
    }),
    assistant('a1', 'claude-o', {
      input_tokens: 1,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 1000,
      output_tokens: 500,
      output_tokens_details: { thinking_tokens: 200 },
    }),
    {
      type: 'cost-state',
      startTime: Date.parse(inside(9)),
      totalCostUSD: 1.5,
      modelUsage: {
        'claude-o[1m]': {
          inputTokens: 1,
          cacheCreationInputTokens: 100,
          // a last response written after this cost-state
          cacheReadInputTokens: 900,
          outputTokens: 600,
        },
        'claude-h': { inputTokens: 3000, outputTokens: 70 },
      },
    },
  ]);

  await jsonl(join(claude, 'main', 'subagents', 'agent-1.jsonl'), [
    assistant('s1', 'claude-h', { input_tokens: 1000, output_tokens: 50 }),
  ]);

  await jsonl(join(claude, 'familiar.jsonl'), [
    {
      type: 'user',
      entrypoint: 'sdk-ts',
      message: { role: 'user', content: 'review this diff' },
    },
    assistant('f1', 'claude-o', { input_tokens: 2, output_tokens: 30 }),
  ]);

  // started before the window, so its directory is older than `--since`
  await jsonl(join(codex, '2026', '11', '01', 'rollout-main.jsonl'), [
    meta('codex-main', 'vscode'),
    user('# AGENTS.md instructions'),
    user(bootstrap),
    context('gpt-x'),
    record(before, 5000, 4000, 10),
    record(inside(10), 3000, 2000, 100, 40),
    balance(10, '100'),
    balance(11, '60'),
    balance(12, '50'),
    balance(13, '0', 'premium'),
  ]);

  await jsonl(join(codex, '2026', '11', '20', 'rollout-fork.jsonl'), [
    meta('codex-fork', { subagent: { thread_spawn: { depth: 1 } } }),
    meta('codex-main', 'vscode'),
    context('gpt-x'),
    record(inside(10), 700, 0, 7),
    // read before the main thread's 60, written after it
    { ...balance(11, '90'), timestamp: '2026-11-20T11:30:00.000Z' },
    balance(14, '55'),
  ]);

  await jsonl(join(codex, '2026', '11', '20', 'rollout-guardian.jsonl'), [
    meta('codex-guardian', { subagent: { other: 'guardian' } }),
    context('codex-auto-review'),
    record(inside(10), 400, 100, 4),
  ]);

  // written before Codex logged per-response usage records
  await jsonl(join(codex, '2026', '11', '20', 'rollout-legacy.jsonl'), [
    meta('codex-legacy', 'vscode'),
    {
      timestamp: inside(10),
      type: 'event_msg',
      payload: { type: 'token_count', info: { last_token_usage: {} } },
    },
  ]);

  return root;
}

let output: Promise<string> | undefined;

function report(): Promise<string> {
  return (output ??= home().then(async (root) => {
    const { stdout } = await execute(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), script, '--since', '2026-11-10'],
      { env: { ...process.env, HOME: root } },
    );

    return stdout;
  }));
}

/** the report's rows as whitespace-split cells, keyed by their label. */
async function table(title: string): Promise<Map<string, string[]>> {
  const [, section = ''] = (await report()).split(`\n${title}\n`);
  const rows = new Map<string, string[]>();

  for (const line of section.split('\n').slice(1)) {
    if (!line) break;

    const cells = line.split(/\s{2,}/);
    rows.set(cells[0]!, cells.slice(1));
  }

  return rows;
}

const byRole = () => table('by role');

test('a response split into rows counts once with its final output', async () => {
  // requests, uncached, cache write, cache read, output, thinking, hit
  assert.deepEqual((await byRole()).get('claude main'), [
    '1',
    '1',
    '100',
    '1K',
    '500',
    '40%',
    '91%',
  ]);
});

test("Codex cached input isn't counted as uncached too", async () => {
  assert.deepEqual((await byRole()).get('codex main'), [
    '1',
    '1K',
    '0',
    '2K',
    '100',
    '40%',
    '67%',
  ]);
});

test('a usage row is counted by its own time, not its rollout directory', async () => {
  const main = (await byRole()).get('codex main')!;
  assert.equal(main[0], '1');
});

test("a fork keeps its own role, not its copied parent's", async () => {
  assert.equal((await byRole()).get('codex native subagent')?.[1], '700');
});

test('guardians and Claude subagent files get their own roles', async () => {
  const roles = await byRole();
  assert.equal(roles.get('codex guardian')?.[1], '300');
  assert.equal(roles.get('claude native subagent')?.[1], '1K');
});

test('a main is found by its bootstrap prompt after other user messages, and other SDK sessions are familiars', async () => {
  const roles = await byRole();
  assert.equal(roles.get('claude familiar')?.[4], '30');
  assert.equal(roles.get('codex familiar'), undefined);
});

test('usage outside transcripts subtracts the main file and its subagents per model', async () => {
  const residuals = await table(
    'Claude usage not in transcripts, cause unverified',
  );

  // sessions, uncached, write, read, output; the `[1m]` key matches `claude-o`, whose short read clamps to 0
  assert.deepEqual(
    [...residuals],
    [
      ['claude-h', ['1', '2K', '0', '0', '20']],
      ['claude-o', ['1', '0', '0', '0', '100']],
    ],
  );

  assert.match(await report(), /predates their last response \(1\)/);
});

test('credits spent ignore stale readings from concurrent sessions and premium rows', async () => {
  const credits = await table('Codex credits beyond plan quota, account-wide');
  assert.deepEqual(credits.get('last'), [inside(14), '55.00']);
  assert.deepEqual(credits.get('spent'), ['50.00']);
});

test('Claude USD comes from the whole session estimate', async () => {
  const usd = await table(
    "Claude USD, Claude Code's API-price estimate for whole sessions started in the window",
  );

  assert.deepEqual(usd.get('main'), ['1', '$1.50']);
});

test('Codex rollouts without per-response records are counted as skipped, not as zero', async () => {
  assert.match(await report(), /\n1 Codex rollouts from before September 2026/);
  assert.equal((await byRole()).get('codex familiar'), undefined);
});
