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
const compacted = 'Conversation compacted';

async function jsonl(file: string, rows: readonly unknown[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n'));
}

/** history rows as `[kind, text, seconds, runtime?]`, or a raw row for updates. */
type Line = [string, string, number, string?] | Record<string, unknown>;

async function conversation(
  home: string,
  id: string,
  sessions: Record<string, { id: string }>,
  lines: readonly Line[],
): Promise<void> {
  const dir = join(home, '.witch', 'conversations', id);
  await jsonl(
    join(dir, 'history.jsonl'),
    lines.map((line, index) => {
      if (!Array.isArray(line)) return line;
      const [kind, text, seconds, title] = line;
      return {
        id: `${id}-${index}`,
        kind,
        text,
        at: at(seconds),
        ...(title ? { title } : {}),
        ...(text === 'cleared' ? { contextCleared: true } : {}),
      };
    }),
  );
  await writeFile(join(dir, 'state.json'), JSON.stringify({ sessions }));
}

function boundary(
  session: string,
  seconds: number,
  trigger: string,
  preTokens: number,
) {
  return {
    subtype: 'compact_boundary',
    entrypoint: 'sdk-ts',
    sessionId: session,
    timestamp: at(seconds),
    compactMetadata: { trigger, preTokens },
  };
}

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
/** a model output item with no role, such as a tool call or reasoning. */
const output = (type: string) => ({ type: 'response_item', payload: { type } });
const compaction = (seconds: number) => ({
  type: 'compacted',
  timestamp: at(seconds),
  payload: {},
});

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
  const find = (conversation: string, seconds: number) =>
    cases.find((c) => c.conversation === conversation && c.at === at(seconds))!;
  /** the packet's text before and after the compaction. */
  const sections = async (record: Record<string, unknown>) => {
    const text = await readFile(
      join(out, 'packets', `${String(record.name)}.md`),
      'utf8',
    );
    const [, opening, before, after] = text.split(
      /## conversation opening|## before compaction|## after compaction/,
    );
    return { opening: opening!, before: before!, after: after! };
  };
  return { find, sections };
}

test('classifies compactions by runtime and trigger and bounds their packets', async () => {
  const home = await scratch('witch-compaction-cases-');
  await conversation(home, 'claude', { claude: { id: 'mine' } }, [
    ['user', 'forgotten request', 0],
    ['notice', 'cleared', 5],
    ['user', 'start the task', 10],
    ['assistant', 'work', 20, 'claude'],
    // a streamed chunk, then a replacement
    { id: 'claude-3', kind: 'assistant', text: 'ing on it' },
    {
      id: 'claude-3',
      kind: 'assistant',
      text: 'finished part one',
      replace: true,
    },
    ['user', 'queued prompt', 30],
    // the queue left it unread and sends it again as a new row
    { id: 'claude-6', kind: 'user', text: '', unread: true },
    ['user', 'queued prompt', 40],
    ['assistant', 'queued answer', 50, 'claude'],
    ['notice', compacted, 100],
    ['user', 'prompt sent before the compaction ran', 101],
    ['assistant', 'answered', 110, 'claude'],
    ['user', 'second after', 200],
    ['user', 'third after', 220],
    ['user', 'fourth after', 240],
    ['user', 'fifth after', 260],
  ]);
  await conversation(home, 'claude-older', { claude: { id: 'newest' } }, [
    ['user', 'older task', 600],
    ['assistant', 'older reply', 650, 'claude'],
    ['notice', compacted, 702],
    ['user', 'older follow-up', 710],
    ['assistant', 'older answer', 720, 'claude'],
  ]);
  const claude = join(home, '.claude', 'projects', 'project');
  await jsonl(join(claude, 'mine.jsonl'), [
    {
      type: 'user',
      entrypoint: 'sdk-ts',
      sessionId: 'mine',
      message: { content: 'a line\u2028separator inside a row' },
    },
    boundary('mine', 98, 'manual', 820000),
    // closest to the older conversation's notice, but another conversation's latest session
    boundary('mine', 701, 'auto', 3),
  ]);
  // closer to the first notice, but in no conversation's latest session
  await jsonl(join(claude, 'other.jsonl'), [boundary('other', 100, 'auto', 1)]);
  await jsonl(join(claude, 'older.jsonl'), [
    boundary('older', 690, 'manual', 450000),
  ]);
  // exact in time, but not Witch's own sessions
  await jsonl(join(claude, 'cli.jsonl'), [
    { ...boundary('cli', 702, 'manual', 5), entrypoint: 'cli' },
  ]);
  await jsonl(join(claude, 'side.jsonl'), [
    { ...boundary('side', 702, 'manual', 6), isSidechain: true },
  ]);
  await conversation(home, 'claude-native', { claude: { id: 'native' } }, [
    ['user', 'native task', 1500],
    ['assistant', 'native progress', 1510, 'claude'],
    // a shell command is not a prompt the agent answers after compaction
    ['user', '!git status', 1590],
    ['notice', compacted, 1600],
    ['assistant', 'native reply', 1610, 'claude'],
  ]);
  await jsonl(join(claude, 'native.jsonl'), [
    boundary('native', 1599, 'auto', 968000),
  ]);

  await conversation(home, 'codex', { codex: { id: 'thread' } }, [
    ['user', 'first', 0],
    ['assistant', 'first reply', 10, 'codex'],
    ['notice', compacted, 300],
    ['user', 'after the command', 301],
    ['assistant', 'command reply', 310, 'codex'],
    ['user', 'prompt the runtime compacted with', 399],
    ['notice', compacted, 400],
    ['assistant', 'start-of-turn reply', 410, 'codex'],
    ['user', 'long task', 990],
    ['assistant', 'progress', 995, 'codex'],
    ['notice', compacted, 1000],
    ['assistant', 'final', 1010, 'codex'],
    ['user', 'p1', 1100],
    ['assistant', 'r1', 1110, 'codex'],
    ['notice', 'cleared', 1150],
    ['user', 'p2 after clear', 1200],
  ]);
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
    compaction(299),
    usage(10),
    event('task_complete'),
    item('user'),
    event('task_started'),
    compaction(399),
    item('assistant'),
    event('task_complete'),
    item('user'),
    event('task_started'),
    item('assistant'),
    usage(600),
    compaction(999),
    item('assistant'),
    event('task_complete'),
  ]);

  await conversation(home, 'codex-older', { codex: { id: 'newer' } }, [
    ['user', 'tool task', 2000],
    ['assistant', 'calling a tool', 2005, 'codex'],
    ['notice', compacted, 2010],
    ['assistant', 'tool result', 2020, 'codex'],
    ['user', 'reasoning task', 2100],
    ['notice', compacted, 2110],
    ['assistant', 'reasoned', 2120, 'codex'],
  ]);
  await jsonl(join(home, '.codex', 'sessions', 'rollout-old-thread.jsonl'), [
    {
      type: 'session_meta',
      payload: { id: 'old-thread', originator: 'witch', source: 'vscode' },
    },
    event('task_started'),
    output('function_call'),
    usage(500),
    compaction(2009),
    event('task_complete'),
    item('user'),
    event('task_started'),
    compaction(2109),
    output('reasoning'),
    event('task_complete'),
  ]);
  // exact in time, each with no output, so either would read as `command`
  for (const [id, meta] of [
    ['foreign', { originator: 'codex_cli_rs', source: 'vscode' }],
    ['subagent', { originator: 'witch', source: { subagent: 'review' } }],
  ] as const)
    await jsonl(join(home, '.codex', 'sessions', `rollout-${id}.jsonl`), [
      { type: 'session_meta', payload: { id, ...meta } },
      event('task_started'),
      compaction(2010),
      compaction(2110),
      event('task_complete'),
    ]);
  // two notices compete for one compaction; the closer one is read second
  for (const [id, seconds] of [
    ['compete-a', 3000],
    ['compete-b', 3010],
  ] as const)
    await conversation(home, id, { claude: { id: `${id}-latest` } }, [
      ['user', 'competing task', seconds - 10],
      ['notice', compacted, seconds],
      ['assistant', 'competing reply', seconds + 5, 'claude'],
    ]);
  await jsonl(join(claude, 'lone.jsonl'), [
    boundary('lone', 3009, 'manual', 700000),
  ]);
  // twelve prompts after a clear: the opening takes the first two, the turns before take the last eight
  const numbered = Array.from({ length: 12 }, (_, index) => {
    const n = String(index + 1).padStart(2, '0');
    return [
      ['user', `prompt-${n}`, 4000 + index * 10],
      ['assistant', `reply-${n}`, 4005 + index * 10, 'claude'],
    ] as Line[];
  }).flat();
  await conversation(home, 'long', { claude: { id: 'long-latest' } }, [
    ['user', 'before the clear', 3900],
    ['notice', 'cleared', 3950],
    ...numbered,
    ['notice', compacted, 4200],
    ['assistant', 'long reply', 4210, 'claude'],
  ]);
  // Finder leaves files beside the conversations
  await writeFile(join(home, '.witch', 'conversations', '.DS_Store'), '');

  const { find, sections } = await extract(home);

  const witch = find('claude', 100);
  assert.deepEqual(
    [witch.runtime, witch.trigger, witch.tokens, witch.session],
    ['claude', 'command', 820000, true],
  );
  const older = find('claude-older', 702);
  assert.deepEqual(
    [older.trigger, older.tokens, older.session],
    ['command', 450000, false],
  );
  const native = find('claude-native', 1600);
  assert.deepEqual(
    [native.runtime, native.trigger, native.tokens],
    ['claude', 'native', 968000],
  );
  const nativePacket = await sections(native);
  assert.ok(nativePacket.before.includes('!git status'));
  assert.ok(!nativePacket.after.includes('!git status'));
  assert.equal(native.promptsAfter, 0);
  assert.equal(find('compete-b', 3010).tokens, 700000);
  assert.equal(find('compete-a', 3000).runtime, undefined);
  const long = await sections(find('long', 4200));
  const has = (text: string, n: number) =>
    text.includes(`prompt-${String(n).padStart(2, '0')}`);
  assert.deepEqual(
    [1, 2, 3].map((n) => has(long.opening, n)),
    [true, true, false],
  );
  assert.ok(long.opening.includes('reply-02'));
  assert.ok(!long.opening.includes('before the clear'));
  assert.deepEqual(
    Array.from({ length: 12 }, (_, i) => has(long.before, i + 1)),
    [
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ],
  );
  const toolTurn = find('codex-older', 2010);
  assert.deepEqual(
    [toolTurn.trigger, toolTurn.afterOutput, toolTurn.tokens, toolTurn.session],
    ['native', true, 500, false],
  );
  const reasoningTurn = find('codex-older', 2110);
  assert.deepEqual(
    [reasoningTurn.trigger, reasoningTurn.afterOutput],
    ['native', false],
  );
  const command = find('codex', 300);
  assert.deepEqual(
    [command.trigger, command.afterOutput, command.tokens, command.percent],
    ['command', false, 799, 79],
  );
  const startOfTurn = find('codex', 400);
  assert.deepEqual(
    [startOfTurn.trigger, startOfTurn.afterOutput],
    ['native', false],
  );
  const midTurn = find('codex', 1000);
  assert.deepEqual(
    [midTurn.trigger, midTurn.afterOutput, midTurn.tokens, midTurn.percent],
    ['native', true, 600, 60],
  );

  const claudePacket = await sections(witch);
  assert.ok(!claudePacket.before.includes('forgotten request'));
  assert.ok(claudePacket.before.includes('finished part one'));
  assert.equal(claudePacket.before.split('queued prompt').length, 2);
  assert.match(
    claudePacket.after,
    /^\s*### user\s+prompt sent before the compaction ran/,
  );
  assert.equal(witch.promptsAfter, 4);
  assert.ok(!claudePacket.after.includes('fifth after'));

  const commandPacket = await sections(command);
  assert.equal(command.promptsAfter, 2);
  assert.ok(!commandPacket.after.includes('start-of-turn reply'));
  assert.match(
    (await sections(startOfTurn)).after,
    /^\s*### user\s+prompt the runtime compacted with/,
  );
  const midTurnPacket = await sections(midTurn);
  assert.match(midTurnPacket.after, /^\s*### agent\s+final/);
  assert.equal(midTurn.promptsAfter, 1);
  assert.ok(!midTurnPacket.after.includes('p2 after clear'));
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
