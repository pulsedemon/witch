import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'vitest';
import { scratch } from './fixtures/scratch.js';

const execute = promisify(execFile);
const script = fileURLToPath(
  new URL('../scripts/compaction-cases.ts', import.meta.url),
);
const start = Date.parse('2026-11-01T00:00:00Z');
const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();

async function jsonl(file: string, rows: readonly unknown[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n'));
}

function history(rows: readonly [string, string, number, string?][]) {
  return rows.map(([kind, text, seconds, title], index) => ({
    id: `row-${index}`,
    kind,
    text,
    at: at(seconds),
    ...(title ? { title } : {}),
    ...(text === 'cleared' ? { contextCleared: true } : {}),
  }));
}

async function conversation(
  home: string,
  id: string,
  sessions: Record<string, { id: string }>,
  rows: readonly [string, string, number, string?][],
): Promise<void> {
  const dir = join(home, '.witch', 'conversations', id);
  await jsonl(join(dir, 'history.jsonl'), history(rows));
  await writeFile(join(dir, 'state.json'), JSON.stringify({ sessions }));
}

async function extract(home: string) {
  const out = join(home, 'out');
  await execute(
    process.execPath,
    ['--import', import.meta.resolve('tsx'), script, '--out', out],
    { env: { ...process.env, HOME: home } },
  );
  const cases = JSON.parse(
    await readFile(join(out, 'cases.json'), 'utf8'),
  ) as Record<string, unknown>[];
  const packet = (name: unknown) =>
    readFile(join(out, 'packets', `${String(name)}.md`), 'utf8');
  return { cases, packet };
}

const compacted = 'Conversation compacted';

test('classifies compactions by runtime and trigger and lays out their packets', async () => {
  const home = await scratch('witch-compaction-cases-');
  await conversation(home, 'claude-conversation', { claude: { id: 'mine' } }, [
    ['user', 'forgotten request', 0],
    ['notice', 'cleared', 5],
    ['user', 'start the task', 10],
    ['assistant', 'working on it', 20, 'claude'],
    ['notice', compacted, 100],
    ['user', 'prompt sent before the compaction ran', 101],
    ['assistant', 'answered', 110, 'claude'],
    ['user', 'second prompt after', 200],
    ['assistant', 'done', 210, 'claude'],
  ]);
  const claude = join(home, '.claude', 'projects', 'project');
  await jsonl(join(claude, 'mine.jsonl'), [
    {
      type: 'user',
      entrypoint: 'sdk-ts',
      sessionId: 'mine',
      message: { content: 'a line separator inside a row' },
    },
    {
      subtype: 'compact_boundary',
      entrypoint: 'sdk-ts',
      sessionId: 'mine',
      timestamp: at(98),
      compactMetadata: { trigger: 'manual', preTokens: 820000 },
    },
  ]);
  // closer in time, but in no conversation's latest session
  await jsonl(join(claude, 'other.jsonl'), [
    {
      subtype: 'compact_boundary',
      entrypoint: 'sdk-ts',
      sessionId: 'other',
      timestamp: at(100),
      compactMetadata: { trigger: 'auto', preTokens: 1 },
    },
  ]);

  await conversation(home, 'codex-conversation', { codex: { id: 'thread' } }, [
    ['user', 'first', 0],
    ['assistant', 'first reply', 10, 'codex'],
    ['notice', compacted, 300],
    ['user', 'after the command', 301],
    ['assistant', 'command reply', 310, 'codex'],
    ['user', 'prompt the runtime compacted with', 399],
    ['notice', compacted, 400],
    ['assistant', 'native reply', 410, 'codex'],
    ['user', 'later', 500],
    ['assistant', 'later reply', 510, 'codex'],
  ]);
  const usage = (total: number) => ({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: { total_tokens: total },
        model_context_window: 1000,
      },
    },
  });
  const event = (type: string) => ({ type: 'event_msg', payload: { type } });
  const item = (role: string) => ({
    type: 'response_item',
    payload: { type: 'message', role },
  });
  await jsonl(join(home, '.codex', 'sessions', 'rollout-thread.jsonl'), [
    {
      type: 'session_meta',
      payload: { id: 'thread', originator: 'witch', source: 'vscode' },
    },
    event('task_started'),
    item('assistant'),
    usage(799),
    event('task_complete'),
    // the next prompt's input lands before its turn starts and must not make the command native
    item('user'),
    event('task_started'),
    { type: 'compacted', timestamp: at(299), payload: {} },
    usage(10),
    event('task_complete'),
    item('user'),
    event('task_started'),
    { type: 'compacted', timestamp: at(399), payload: {} },
    item('assistant'),
    event('task_complete'),
  ]);

  const { cases, packet } = await extract(home);
  const pick = (conversation: string, seconds: number) =>
    cases.find((c) => c.conversation === conversation && c.at === at(seconds))!;

  const witch = pick('claude-conversation', 100);
  assert.deepEqual(
    [witch.runtime, witch.trigger, witch.tokens, witch.session],
    ['claude', 'command', 820000, true],
  );
  const command = pick('codex-conversation', 300);
  assert.deepEqual(
    [command.trigger, command.afterOutput, command.tokens, command.percent],
    ['command', false, 799, 79],
  );
  const native = pick('codex-conversation', 400);
  assert.deepEqual([native.trigger, native.afterOutput], ['native', false]);

  const [, before, after] = (await packet(witch.name)).split(
    /## before compaction|## after compaction/,
  );
  assert.ok(!before!.includes('forgotten request'));
  assert.ok(before!.includes('working on it'));
  assert.match(after!, /^\s*### user\s+prompt sent before the compaction ran/);
  const nativeAfter = (await packet(native.name)).split(
    '## after compaction',
  )[1]!;
  assert.match(nativeAfter, /^\s*### user\s+prompt the runtime compacted with/);
});

test('stops on a malformed row before the last one', async () => {
  const home = await scratch('witch-compaction-cases-');
  const dir = join(home, '.witch', 'conversations', 'broken');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'history.jsonl'),
    `{"kind":"user","text":"a","at":"${at(0)}"}\n{"kind":\n{"kind":"user","text":"b","at":"${at(1)}"}\n`,
  );
  await assert.rejects(extract(home), /history\.jsonl:2: malformed JSON row/);
});
