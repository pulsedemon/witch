import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { assignGitHubTask } from '../src/core/github-assignment.js';
import { callControl } from '../src/persistence/control.js';
import { coordinationFixture } from './fixtures/coordination.js';
import { selectionTurn } from './fixtures/task-selection.js';
import { until, within } from './fixtures/within.js';

async function fixture(t: TestContext, assign = assignGitHubTask) {
  const f = await coordinationFixture(t, assign);
  const bin = join(f.root, 'bin');
  const policy = join(f.root, 'github-policy.json');
  const calls = join(f.root, 'github-calls.jsonl');
  const release = join(f.root, 'github-release');
  await mkdir(bin);
  await writeFile(policy, '{}');
  await writeFile(calls, '');
  await writeFile(
    join(bin, 'gh'),
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const policy = JSON.parse(fs.readFileSync(${JSON.stringify(policy)}, 'utf8'));
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, pid: process.pid }) + '\\n');
const endpoint = args[3];
function reply() {
  if (policy.failed === endpoint) {
    process.stderr.write('assignment permission denied\\n');
    process.exitCode = 1;
  } else if (endpoint === 'user') {
    process.stdout.write('task-user\\n');
  } else {
    process.stdout.write(JSON.stringify(policy.ignored === endpoint ? ['existing-owner'] : ['existing-owner', 'task-user']));
  }
}
if (policy.hold === endpoint) {
  process.on('SIGTERM', () => {});
  const timer = setInterval(() => {
    if (!fs.existsSync(${JSON.stringify(release)})) return;
    clearInterval(timer);
    reply();
  }, 10);
} else reply();
`,
    { mode: 0o700 },
  );
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  t.after(() => {
    process.env.PATH = previous;
  });
  return {
    ...f,
    configure: (value: object) => writeFile(policy, JSON.stringify(value)),
    release: () => writeFile(release, ''),
    async calls(): Promise<{ args: string[]; pid: number }[]> {
      const text = (await readFile(calls, 'utf8')).trim();
      return text ? text.split('\n').map((line) => JSON.parse(line)) : [];
    },
  };
}

const input = {
  reference: 'https://github.com/ACME/widget/issues/42',
  aliases: [
    'https://github.com/acme/widget/pull/77',
    'https://github.com/acme/widget/pull/42',
    'task:local',
  ],
  summary: 'GitHub task',
};
const issue = 'repos/acme/widget/issues/42/assignees';

await test('a successful claim assigns its distinct GitHub references, and a conflicting claim never reaches GitHub', async (t) => {
  const f = await fixture(t);
  const a = await f.start(),
    b = await f.start('B');
  const claimed = await callControl(await a.binding(), {
    kind: 'claim',
    input,
  });
  if (claimed.kind !== 'claimed') assert.fail(JSON.stringify(claimed));
  assert.equal(claimed.warning, undefined);
  assert.deepEqual(await f.registry.claims(), [claimed.claim]);
  const calls = await f.calls();
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ['api', '--hostname', 'github.com', 'user', '--jq', '.login'],
      ...[issue, 'repos/acme/widget/issues/77/assignees'].map((endpoint) => [
        'api',
        '--hostname',
        'github.com',
        endpoint,
        '--method',
        'POST',
        '-f',
        'assignees[]=task-user',
        '--jq',
        '[.assignees[].login]',
      ]),
    ],
  );
  assert.equal((await b.claim(input.reference)).kind, 'conflict');
  assert.deepEqual(await f.calls(), calls);
  await a.coordination.releaseTask();
  assert.deepEqual(await f.registry.claims(), []);
  assert.equal((await a.claim('task:local-only')).kind, 'claimed');
  assert.deepEqual(await f.calls(), calls);
});

await test('a recommendation assigns only when promoted to an active claim', async (t) => {
  const f = await fixture(t);
  const a = await f.start();
  const turn = await selectionTurn(t, a);
  const selection = await turn.select();
  const suggested = await turn.recommend(selection.ticket.id);
  assert.deepEqual(await f.calls(), []);
  const promoted = await a.claim('https://github.com/acme/queue/issues/17');
  if (promoted.kind !== 'claimed') assert.fail(JSON.stringify(promoted));
  assert.equal(promoted.claim.id, suggested.id);
  assert.equal(promoted.claim.suggestion, undefined);
  assert.equal(promoted.warning, undefined);
  assert.deepEqual(
    (await f.calls()).map((call) => call.args[3]),
    ['user', 'repos/acme/queue/issues/17/assignees'],
  );
  await turn.finish();
});

for (const scenario of [
  {
    name: 'authentication failure',
    policy: { failed: 'user' },
    message: /permission denied/,
  },
  {
    name: 'assignment failure',
    policy: { failed: issue },
    message: /permission denied/,
  },
  {
    name: 'an ignored assignee',
    policy: { ignored: issue },
    message: /did not confirm assignment to task-user/,
  },
]) {
  await test(`${scenario.name} returns a warning with ownership intact, and repeating the claim retries`, async (t) => {
    const f = await fixture(t);
    const a = await f.start();
    const binding = await a.binding();
    await f.configure(scenario.policy);
    const claimed = await callControl(binding, { kind: 'claim', input });
    if (claimed.kind !== 'claimed') assert.fail(JSON.stringify(claimed));
    assert.match(claimed.warning ?? '', scenario.message);
    assert.deepEqual(await f.registry.claims(), [claimed.claim]);
    const snapshot = await a.query();
    assert.equal(snapshot.ownClaim?.id, claimed.claim.id);
    assert.equal(snapshot.error, undefined);
    assert.deepEqual(
      (await f.calls()).map((call) => call.args[3]),
      scenario.policy.failed === 'user'
        ? ['user']
        : ['user', issue, 'repos/acme/widget/issues/77/assignees'],
    );
    await f.configure({});
    const retried = await callControl(binding, { kind: 'claim', input });
    if (retried.kind !== 'claimed') assert.fail(JSON.stringify(retried));
    assert.equal(retried.claim.id, claimed.claim.id);
    assert.equal(retried.warning, undefined);
    assert.deepEqual(
      (await f.calls()).slice(-3).map((call) => call.args[3]),
      ['user', issue, 'repos/acme/widget/issues/77/assignees'],
    );
  });
}

for (const [name, endpoint, expected] of [
  ['login', 'user', ['user']],
  ['assignment', issue, ['user', issue]],
] as const) {
  await test(`${name} timeout returns a warning with ownership intact`, async (t) => {
    const f = await fixture(t, (references, cwd, deadline) =>
      assignGitHubTask(references, cwd, Math.min(deadline, Date.now() + 2000)),
    );
    const a = await f.start();
    await f.configure({ hold: endpoint });
    t.after(f.release);
    const claiming = callControl(await a.binding(), {
      kind: 'claim',
      input: { reference: input.reference, summary: input.summary },
    });
    try {
      const claimed = await within(claiming, 5000, 'timeout warning');
      if (claimed.kind !== 'claimed') assert.fail(JSON.stringify(claimed));
      assert.match(
        claimed.warning ?? '',
        /Timed out after \d+ ms: Command failed: gh api/,
      );
      if (endpoint === issue)
        assert.ok(claimed.warning?.includes(`${issue}: Timed out after `));
      assert.deepEqual(await f.registry.claims(), [claimed.claim]);
      const snapshot = await a.query();
      assert.equal(snapshot.ownClaim?.id, claimed.claim.id);
      assert.equal(snapshot.error, undefined);
      const calls = await f.calls();
      assert.deepEqual(
        calls.map((call) => call.args[3]),
        expected,
      );
      assert.throws(() => process.kill(calls.at(-1)!.pid, 0), {
        code: 'ESRCH',
      });
    } finally {
      await f.release();
      await claiming;
    }
  });
}

await test('a pending GitHub assignment leaves the shared ledger available and drains before close releases its claim', async (t) => {
  const f = await fixture(t);
  const a = await f.start(),
    b = await f.start('B');
  await f.configure({ hold: issue });
  t.after(f.release);
  const claiming = a.claim(input.reference);
  try {
    await until(
      'assignment started',
      async () => (await f.calls()).length === 2,
    );
    const other = await within(
      b.claim('task:other'),
      5000,
      'independent claim',
    );
    if (other.kind !== 'claimed') assert.fail(JSON.stringify(other));
    const closing = a.coordinator.close();
    assert.equal((await f.registry.claims()).length, 2);
    await f.release();
    const claimed = await claiming;
    if (claimed.kind !== 'claimed') assert.fail(JSON.stringify(claimed));
    assert.equal(claimed.warning, undefined);
    await closing;
    assert.deepEqual(await f.registry.claims(), [other.claim]);
    assert.deepEqual(
      (await f.calls()).map((call) => call.args[3]),
      ['user', issue],
    );
  } finally {
    await f.release();
    await claiming;
  }
});

await test('an expired assignment starts no command and a stalled GitHub command is reaped at its deadline', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    assignGitHubTask(['github:acme/widget#42'], f.root, Date.now() - 1),
    /deadline expired/,
  );
  assert.deepEqual(await f.calls(), []);
  await f.configure({ hold: issue });
  t.after(f.release);
  await assert.rejects(
    within(
      assignGitHubTask(['github:acme/widget#42'], f.root, Date.now() + 2000),
      5000,
      'assignment deadline',
    ),
    /Timed out after \d+ ms: Command failed/,
  );
  const calls = await f.calls();
  assert.deepEqual(
    calls.map((call) => call.args[3]),
    ['user', issue],
  );
  assert.throws(() => process.kill(calls[1]!.pid, 0), { code: 'ESRCH' });
});
