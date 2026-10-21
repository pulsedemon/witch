import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { controlPrefix, parseCommand } from '../src/cli-control.js';
import { ControlHost, callControl } from '../src/persistence/control.js';
import type { ControlOutcome } from '../src/persistence/control.js';
import { coordinationFixture, git } from './fixtures/coordination.js';
import { selectionTurn } from './fixtures/task-selection.js';
import { until, within } from './fixtures/within.js';

const execute = promisify(execFile);
function invoke(t: TestContext, prefix: string, cwd: string, args: string) {
  const operation = execute('/bin/zsh', ['-c', `${prefix} ${args} --json`], {
    cwd,
    timeout: 30000,
  });
  const child = operation.child;
  const ended = new Promise<void>((resolve) =>
    child.once('exit', () => resolve()),
  );
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    await ended;
  });
  const result = operation
    .then(
      (result) => ({ ...result, code: 0 }),
      (error: unknown) => {
        if (
          !error ||
          typeof error !== 'object' ||
          !('stdout' in error) ||
          !('stderr' in error) ||
          !('code' in error)
        )
          throw error;
        return {
          stdout: String(error.stdout),
          stderr: String(error.stderr),
          code: error.code,
        };
      },
    )
    .then((result) => ({
      ...result,
      outcome: JSON.parse(result.stdout) as ControlOutcome,
    }));
  return { result, child };
}

await test('waiting helpers leave the host responsive beyond a request deadline and start work in FIFO order', async (t) => {
  const f = await coordinationFixture(t);
  await git('clone', join(f.root, 'origin'), join(f.root, 'D'));
  const a = await f.start(),
    b = await f.start('B'),
    c = await f.start('D');
  const first = await selectionTurn(t, a),
    second = await selectionTurn(t, b),
    third = await selectionTurn(t, c);
  const markers = join(f.root, 'selected');
  const choose = async (turn: typeof first, name: string) => {
    const result = await invoke(
      t,
      turn.prefix,
      f.root,
      `--select-next ${turn.turn}`,
    ).result;
    assert.equal(result.code, 0);
    if (result.outcome.kind !== 'selection')
      assert.fail(JSON.stringify(result));
    assert.equal(result.outcome.selection.position, 1);
    await appendFile(markers, `${name}\n`);
    return result.outcome;
  };
  const chosen = await choose(first, 'A');
  let secondDone = false,
    thirdDone = false;
  const waiting = choose(second, 'B').then((result) => {
    secondDone = true;
    return result;
  });
  await until(
    'second ticket',
    async () => (await f.registry.state()).selections.length === 2,
  );
  const last = choose(third, 'C').then((result) => {
    thirdDone = true;
    return result;
  });
  await until(
    'third ticket',
    async () => (await f.registry.state()).selections.length === 3,
  );
  await delay(11000);
  assert.equal(secondDone, false);
  assert.equal(thirdDone, false);
  const peers = await within(
    invoke(t, second.prefix, f.root, '--peers').result,
    5000,
    'peers while helper waits',
  );
  assert.equal(peers.outcome.kind, 'peers');
  await invoke(
    t,
    first.prefix,
    f.root,
    `--recommend https://github.com/acme/queue/issues/17 --selection ${chosen.selection.ticket.id} --summary 'Issue 17'`,
  ).result;
  await first.finish();
  const ready = await within(waiting, 5000, 'automatic second grant');
  assert.deepEqual(
    ready.snapshot.peers.find((peer) => peer.claim)?.claim?.references,
    ['github:acme/queue#17'],
  );
  assert.equal(a.coordinator.snapshot.phase, 'idle');
  await second.recommend(ready.selection.ticket.id, 18);
  await second.finish();
  const final = await within(last, 5000, 'automatic third grant');
  await third.recommend(final.selection.ticket.id, 19);
  await third.finish();
  assert.equal(await readFile(markers, 'utf8'), 'A\nB\nC\n');
  assert.deepEqual(
    (await f.registry.claims()).map((claim) => claim.references),
    [
      ['github:acme/queue#17'],
      ['github:acme/queue#18'],
      ['github:acme/queue#19'],
    ],
  );
  assert.deepEqual((await f.registry.state()).selections, []);
});

await test('a waiting helper can cancel without ending its native turn and rejoin at the tail', async (t) => {
  const f = await coordinationFixture(t);
  const a = await f.start(),
    b = await f.start('B');
  const first = await selectionTurn(t, a),
    second = await selectionTurn(t, b);
  const head = await first.select();
  const waiting = invoke(
    t,
    second.prefix,
    f.root,
    `--select-next ${second.turn}`,
  );
  await until(
    'waiter enqueued',
    async () => (await f.registry.state()).selections.length === 2,
  );
  const queued = (await f.registry.state()).selections[1]!;
  const cancel = await within(
    invoke(t, second.prefix, f.root, `--cancel-selection ${queued.id}`).result,
    5000,
    'cancel while helper waits',
  );
  assert.equal(cancel.outcome.kind, 'selection-cancelled');
  const cancelled = await waiting.result;
  assert.equal(cancelled.code, 1);
  assert.equal(cancelled.outcome.kind, 'error');
  assert.match(cancelled.stderr, new RegExp(`${queued.id}: queued #2`));
  assert.equal(b.coordinator.snapshot.phase, 'running');
  const rejoined = await second.select();
  assert.equal(rejoined.position, 2);
  assert.notEqual(rejoined.ticket.id, queued.id);
  assert.deepEqual(
    (await f.registry.state()).selections.map((ticket) => ticket.id),
    [head.ticket.id, rejoined.ticket.id],
  );
});

await test('SIGTERM cancels the waiting helper ticket with one final result', async (t) => {
  const f = await coordinationFixture(t);
  const a = await f.start(),
    b = await f.start('B');
  const first = await selectionTurn(t, a),
    second = await selectionTurn(t, b);
  const head = await first.select();
  const waiting = invoke(
    t,
    second.prefix,
    f.root,
    `--select-next ${second.turn}`,
  );
  await until(
    'waiter published',
    async () => (await f.registry.state()).selections.length === 2,
  );
  waiting.child.kill('SIGTERM');
  const result = await within(waiting.result, 5000, 'helper termination');
  assert.equal(result.code, 130);
  assert.equal(result.outcome.kind, 'selection-cancelled');
  assert.equal(result.stdout.trim().split('\n').length, 1);
  assert.deepEqual((await f.registry.state()).selections, [head.ticket]);
  assert.equal(b.coordinator.snapshot.phase, 'running');
});

for (const [failure, signal] of [
  ['error', 'SIGINT'],
  ['malformed', 'SIGTERM'],
] as const)
  await test(`${signal} cancels a known ticket after the ${failure} status reply`, async (t) => {
    const f = await coordinationFixture(t);
    const a = await f.start(),
      b = await f.start('B');
    const first = await selectionTurn(t, a),
      second = await selectionTurn(t, b);
    const head = await first.select();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    t.after(() => release.resolve());
    const binding = { ...second.binding, directory: join(f.root, 'proxy') };
    const actions: string[] = [];
    const failures: unknown[] = [];
    const host = await ControlHost.open(
      binding.directory,
      async (request) => {
        actions.push(request.action.kind);
        if (request.action.kind === 'selection-status') {
          entered.resolve();
          await release.promise;
          return failure === 'error'
            ? { kind: 'error', message: 'Temporary status failure' }
            : ({ kind: 'malformed-status' } as unknown as ControlOutcome);
        }
        return callControl(second.binding, request.action);
      },
      (error) => failures.push(error),
    );
    t.after(() => host.close());
    const prefix = controlPrefix(
      binding,
      fileURLToPath(new URL('../src/cli.tsx', import.meta.url)),
    );
    const waiting = invoke(t, prefix, f.root, `--select-next ${second.turn}`);
    await within(entered.promise, 5000, 'status request');
    const queued = (await f.registry.state()).selections[1]!;
    waiting.child.kill(signal);
    await delay(100);
    release.resolve();
    const result = await within(waiting.result, 5000, 'helper cancellation');
    assert.equal(result.code, 130);
    assert.equal(result.outcome.kind, 'selection-cancelled');
    if (result.outcome.kind !== 'selection-cancelled')
      assert.fail(JSON.stringify(result));
    assert.equal(result.outcome.selection, queued.id);
    assert.equal(result.stdout.trim().split('\n').length, 1);
    assert.deepEqual((await f.registry.state()).selections, [head.ticket]);
    assert.equal(b.coordinator.snapshot.phase, 'running');
    assert.deepEqual(actions, [
      'select-next',
      'selection-status',
      'cancel-selection',
    ]);
    assert.deepEqual(failures, []);
  });

await test('selection commands validate bindings and action-specific arguments before startup', () => {
  const turn = randomUUID(),
    ticket = randomUUID();
  const binding = [
    '--control-dir',
    '/private/control',
    '--control-conversation',
    'conversation',
    '--control-activation',
    randomUUID(),
  ];
  const action = (args: string[]) =>
    parseCommand([...binding, ...args]).control!.action;
  assert.deepEqual(action(['--select-next', turn]), {
    kind: 'select-next',
    turn,
  });
  assert.deepEqual(action(['--cancel-selection', ticket]), {
    kind: 'cancel-selection',
    selection: ticket,
  });
  assert.deepEqual(
    action([
      '--recommend',
      'task:chosen',
      '--selection',
      ticket,
      '--summary',
      'Chosen task',
      '--alias',
      'task:alias',
    ]),
    {
      kind: 'recommend',
      selection: ticket,
      input: {
        reference: 'task:chosen',
        summary: 'Chosen task',
        aliases: ['task:alias'],
      },
    },
  );
  for (const invalid of [
    ['--select-next', ''],
    ['--select-next', turn, '--peers'],
    ['--select-next', turn, '--claim', 'task:x'],
    ['--recommend', 'task:x', '--summary', 'X'],
    ['--recommend', 'task:x', '--selection', ticket],
    ['--claim', 'task:x', '--summary', 'X', '--selection', ticket],
    ['--cancel-selection', ticket, '--summary', 'X'],
    ['--select-next', turn, '--state-dir', '/other'],
  ])
    assert.throws(() => action(invalid));
  assert.throws(
    () => parseCommand(['--select-next', turn]),
    /complete control prefix/,
  );
});
