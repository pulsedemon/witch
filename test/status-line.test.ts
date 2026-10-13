import assert from 'node:assert/strict';
import { test } from 'node:test';
import stripAnsi from 'strip-ansi';
import { statusLines } from '../src/ui/status-line.js';

const now = Date.parse('2026-10-13T12:00:00Z');
const seconds = now / 1000;

await test('the status line shows every reported field in the order and format statusline.sh draws', () => {
  const [first, second] = statusLines(
    {
      model: 'GPT-5.5-Codex',
      effort: 'xhigh',
      usage: {
        context: 45.8,
        cost: 1.234,
        limits: [
          { window: '5H', percent: 23.4, resetsAt: seconds + 2 * 3600 + 600 },
          { window: '7D', percent: 41, resetsAt: seconds + 3 * 86_400 + 7200 },
        ],
        lines: { added: 12, removed: 3 },
      },
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
          checks: 'passing',
        },
      },
    },
    now,
  );
  assert.equal(
    stripAnsi(first),
    'GPT-5.5-CODEX | XHIGH | $1.23 | 1H05M | 5H 23% 2h10m 7D 41% 3d2h',
  );
  assert.equal(
    stripAnsi(second),
    'CTX 45% ████░░░░░░ | witch | feat/x ↑1 ↓2 +3 ~4 !1 ?5 | PR#7 ✓ | 12+/3-',
  );
  assert.ok(
    second.includes('\u001b]8;;https://github.com/o/r/pull/7\u0007PR#7'),
  );
});

await test('what no agent or repository reported yet takes the script defaults, and Git and limits stay out', () => {
  const lines = statusLines({ usage: {}, cwd: '/work/witch' }, now).map(
    (line) => stripAnsi(line),
  );
  assert.deepEqual(lines, [
    '? | DEFAULT | $0.00 | 0M',
    'CTX 0% ░░░░░░░░░░ | witch | 0+/0-',
  ]);
});

await test('limits turn yellow at 70% and red at 90%, a past reset shows no time, and the bar warms from 40%', () => {
  const [first] = statusLines(
    {
      usage: {
        limits: [
          { window: '5H', percent: 69.4 },
          { window: '7D', percent: 69.6, resetsAt: seconds - 60 },
          { window: '30D', percent: 90 },
        ],
      },
      cwd: '/w',
    },
    now,
  );
  assert.ok(first.includes('5H 69%'), first);
  assert.ok(first.includes('7D \u001b[33m70%\u001b[39m'), first);
  assert.ok(first.includes('30D \u001b[31m90%\u001b[39m'), first);
  const bar = (context: number) =>
    statusLines({ usage: { context }, cwd: '/w' }, now)[1];
  assert.ok(!bar(39).includes('\u001b[38;2'));
  assert.ok(bar(45).includes('\u001b[38;2;255;255;128m'));
  assert.ok(bar(55).includes('\u001b[38;2;255;128;0m'));
  assert.ok(bar(60).includes('\u001b[38;2;255;0;0m'));
});

await test('a merged pull request says so in magenta, a closed one plainly, and failing or pending checks get their marks', () => {
  const pr = (
    state: 'OPEN' | 'MERGED' | 'CLOSED',
    checks?: 'failing' | 'pending',
  ) =>
    stripAnsi(
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
            pullRequest: { number: 3, url: 'https://x.test/3', state, checks },
          },
        },
        now,
      )[1],
    );
  assert.ok(pr('MERGED').includes('| main | PR#3 MERGED |'));
  assert.ok(pr('CLOSED').includes('| PR#3 CLOSED |'));
  assert.ok(pr('OPEN', 'failing').includes('| PR#3 ✗ |'));
  assert.ok(pr('OPEN', 'pending').includes('| PR#3 … |'));
});
