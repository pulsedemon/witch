import assert from 'node:assert/strict';
import { test } from 'vitest';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import type { Limit } from '../src/agents/types.js';
import { statusLines } from '../src/ui/status-line.js';

const now = Date.parse('2026-10-13T12:00:00Z');
const seconds = now / 1000;

test('the status line shows reported fields with the context capacity beside its percentage', () => {
  const [first, second] = statusLines(
    {
      model: 'GPT-5.5-Codex',
      effort: 'xhigh',
      usage: {
        context: 45.8,
        contextWindow: 828400,
        lines: { added: 12, removed: 3 },
      },
      limits: [
        {
          window: '5H',
          percent: 23.4,
          resetsAt: seconds + 2 * 3600 + 600,
          observedAt: now,
        },
        {
          window: '7D',
          percent: 41,
          resetsAt: seconds + 3 * 86_400 + 7200,
          observedAt: now,
        },
      ],
      openedAt: now - (65 * 60 + 59) * 1000,
      cwd: '/work/witch',
      repository: {
        branch: 'feat/x',
        ahead: 1,
        behind: 2,
        staged: 3,
        modified: 4,
        conflicts: 1,
        untracked: 5,
        pullRequest: {
          number: 7,
          url: 'https://github.com/o/r/pull/7',
          state: 'OPEN',
          branch: 'feat/x',
          commit: 'a1b2c3',
          base: 'main',
          checks: 'passing',
        },
      },
    },
    now,
  );
  assert.equal(
    stripAnsi(first),
    'GPT-5.5-CODEX | XHIGH | 1H05M | 5H 23% 2h10m 7D 41% 3d2h',
  );
  assert.equal(
    stripAnsi(second),
    'CTX 45% (828.4K) ████░░░░░░ | witch | feat/x ↑1 ↓2 +3 ~4 !1 ?5 | PR#7 ✓ | 12+/3-',
  );
  assert.ok(
    second.includes(
      '\u001b]8;;https://github.com/o/r/pull/7\u0007\u001b[4mPR#7',
    ),
  );
  assert.ok(
    second.includes('\u001b]8;;vscode://file/work/witch\u0007\u001b[4mwitch'),
  );
});

test('what no agent or repository reported yet takes the script defaults, and Git and limits stay out', () => {
  const lines = statusLines({ usage: {}, cwd: '/work/witch' }, now).map(
    (line) => stripAnsi(line),
  );
  assert.deepEqual(lines, [
    '? | DEFAULT | 0M',
    'CTX 0% ░░░░░░░░░░ | witch | 0+/0-',
  ]);
});

test('a directory name with a line break stays on the second status row', () => {
  const lines = statusLines({ usage: {}, cwd: '/work/dry\nline' }, now).map(
    (line) => stripAnsi(line),
  );
  assert.deepEqual(lines, [
    '? | DEFAULT | 0M',
    'CTX 0% ░░░░░░░░░░ | dry line | 0+/0-',
  ]);
});

test('a model or effort carrying a link sequence shows as plain text', () => {
  const forged = (text: string) =>
    `\u001b]8;;x-evil:payload\u0007${text}\u001b]8;;\u0007`;
  const [first] = statusLines(
    { model: forged('model'), effort: forged('high'), usage: {}, cwd: '/w' },
    now,
  );
  assert.ok(!first!.includes('\u001b]8;;'), JSON.stringify(first));
  assert.equal(stripAnsi(first!), 'MODEL | HIGH | 0M');
});

test('a conversation opened since the clock was last read shows 0M, not a negative time', () => {
  const [first] = statusLines(
    { usage: {}, cwd: '/w', openedAt: now + 300 },
    now,
  );
  assert.equal(stripAnsi(first), '? | DEFAULT | 0M');
});

test('limits turn yellow at 70% and red at 90%, a past reset shows dim with its age, and the bar warms from 40%', () => {
  const [first] = statusLines(
    {
      usage: {},
      limits: [
        { window: '5H', percent: 69.4, observedAt: now },
        {
          window: '7D',
          percent: 69.6,
          resetsAt: seconds - 60,
          observedAt: now,
        },
        { window: '30D', percent: 90, observedAt: now },
      ],
      cwd: '/w',
    },
    now,
  );
  assert.equal(
    stripAnsi(first),
    '? | DEFAULT | 0M | 5H 69% 7D 70%  0M OLD 30D 90%',
  );
  assert.ok(first.includes('\u001b[2m7D 70%  0M OLD\u001b[22m'), first);
  assert.ok(first.includes('30D \u001b[31m90%\u001b[39m'), first);
  const bar = (context: number) =>
    statusLines({ usage: { context }, cwd: '/w' }, now)[1];
  assert.ok(!bar(39).includes('\u001b[38;2'));
  assert.ok(bar(45).includes('\u001b[38;2;255;255;128m'));
  assert.ok(bar(55).includes('\u001b[38;2;255;128;0m'));
  assert.ok(bar(60).includes('\u001b[38;2;255;0;0m'));
});

test('a merged pull request says so in magenta, a closed one plainly, and failing or pending checks get their marks', () => {
  const line = (
    state: 'OPEN' | 'MERGED' | 'CLOSED',
    checks?: 'failing' | 'pending',
  ) =>
    statusLines(
      {
        usage: {},
        cwd: '/w',
        repository: {
          branch: 'main',
          ahead: 0,
          behind: 0,
          staged: 0,
          modified: 0,
          conflicts: 0,
          untracked: 0,
          pullRequest: {
            number: 3,
            url: 'https://x.test/3',
            state,
            branch: 'feat/x',
            commit: 'a1b2c3',
            base: 'main',
            checks,
          },
        },
      },
      now,
    )[1];
  const pr = (...args: Parameters<typeof line>) => stripAnsi(line(...args));
  assert.ok(pr('MERGED').includes('| main | PR#3 MERGED |'));
  assert.ok(line('MERGED').includes('\u001b[35mMERGED\u001b[39m'));
  assert.ok(pr('CLOSED').includes('| PR#3 CLOSED |'));
  assert.ok(pr('OPEN', 'failing').includes('| PR#3 ✗ |'));
  assert.ok(pr('OPEN', 'pending').includes('| PR#3 … |'));
});

test('other runtimes follow the live one as percents, dim when not current, and ? with no reading', () => {
  const [first] = statusLines(
    {
      usage: {},
      cwd: '/w',
      limits: [
        {
          window: '7D',
          percent: 49,
          resetsAt: seconds + 86_400,
          observedAt: now,
        },
      ],
      others: [
        {
          id: 'claude',
          limits: [
            { window: '5H', percent: 20, observedAt: now - 11 * 60_000 },
            { window: '7D', percent: 75, observedAt: now },
          ],
        },
        { id: 'other' },
      ],
    },
    now,
  );
  assert.equal(
    stripAnsi(first),
    '? | DEFAULT | 0M | 7D 49% 1d0h | CLAUDE 5H 20% 7D 75% | OTHER ?',
  );
  assert.ok(first.includes('\u001b[2m5H 20%\u001b[22m'), first);
});

test('a first row that would overflow drops the live reset times, so the other runtime stays whole', () => {
  const window = (name: string, percent: number, reset?: number): Limit => ({
    window: name,
    percent,
    observedAt: now,
    ...(reset === undefined ? {} : { resetsAt: seconds + reset }),
  });
  const first = (codex: Limit[]) =>
    statusLines(
      {
        model: 'gpt-6.1-terra',
        effort: 'xhigh',
        usage: {},
        cwd: '/w',
        openedAt: now - 83 * 60_000,
        limits: codex,
        others: [
          { id: 'claude', limits: [window('5H', 20), window('7D', 75)] },
        ],
      },
      now,
      78,
    )[0];
  const both = first([
    window('5H', 12, 2 * 3600 + 600),
    window('7D', 40, 3 * 86_400 + 7200),
  ]);
  assert.equal(
    stripAnsi(both),
    'GPT-6.1-TERRA | XHIGH | 1H23M | 5H 12% 7D 40% | CLAUDE 5H 20% 7D 75%',
  );
  assert.ok(stringWidth(both) <= 78);
  assert.equal(
    stripAnsi(first([window('7D', 40, 3 * 86_400 + 7200)])),
    'GPT-6.1-TERRA | XHIGH | 1H23M | 7D 40% 3d2h | CLAUDE 5H 20% 7D 75%',
  );
});
