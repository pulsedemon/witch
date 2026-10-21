import assert from 'node:assert/strict';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AgentEvent, UserRequest } from '../src/agents/types.js';
import type { RpcMessage } from '../src/agents/json-rpc.js';
import { fixture, close } from './fixtures/codex-adapter.js';
import { until } from './fixtures/within.js';

const proposal = (
  threadId: string,
  turnId: string,
  id: string,
  changes: unknown[],
): RpcMessage => ({
  method: 'item/started',
  params: {
    threadId,
    turnId,
    item: { id, type: 'fileChange', status: 'inProgress', changes },
  },
});
const approval = (
  id: number,
  threadId: string,
  turnId: string,
  itemId: string,
): RpcMessage => ({
  id,
  method: 'item/fileChange/requestApproval',
  params: {
    threadId,
    turnId,
    itemId,
    startedAtMs: 1,
    reason: `reason ${id}`,
    grantRoot: '/work',
  },
});

async function approvalsFixture() {
  const events: AgentEvent[] = [];
  const context = await fixture((event) => events.push(event), {
    mode: 'file-approvals',
  });
  let sequence = 0;
  const emit = async (...frames: RpcMessage[]) => {
    const index = ++sequence;
    const barrier = `approval barrier ${index}`;
    const file = join(context.cwd, `events-${index}.json`);
    await writeFile(
      `${file}.next`,
      JSON.stringify([
        ...frames,
        {
          method: 'error',
          params: { willRetry: true, error: { message: barrier } },
        },
      ]),
    );
    await rename(`${file}.next`, file);
    await until(barrier, () =>
      events.some((event) => event.type === 'notice' && event.text === barrier),
    );
  };
  const request = (id: number): UserRequest => {
    const event = events.find(
      (event) => event.type === 'request' && event.request.id === String(id),
    );
    assert.ok(event?.type === 'request');
    return event.request;
  };
  const receipt = async (id: number): Promise<unknown> => {
    const file = join(context.cwd, `response-${id}.json`);
    await until(`receipt ${id}`, () =>
      readFile(file).then(
        () => true,
        () => false,
      ),
    );
    return JSON.parse(await readFile(file, 'utf8')) as unknown;
  };
  return { ...context, events, emit, request, receipt };
}

await test('file approvals use their exact thread, turn and item proposal', async () => {
  const f = await approvalsFixture();
  try {
    await f.emit(
      proposal('native-thread', 'first', 'shared', [
        {
          path: '/work/old.txt',
          kind: { type: 'update', move_path: '/work/moved.txt' },
          diff: '@@ -3,2 +3,2 @@\n-before\n+after\n context\n\nMoved to: /work/moved.txt',
        },
      ]),
      proposal('native-thread', 'second', 'shared', [
        {
          path: '/work/created.txt',
          kind: { type: 'add' },
          diff: 'created\nlast\n',
        },
      ]),
      proposal('child-thread', 'first', 'shared', [
        {
          path: '/work/deleted.txt',
          kind: { type: 'delete' },
          diff: 'deleted\ntail\n',
        },
      ]),
      approval(901, 'child-thread', 'first', 'shared'),
      approval(902, 'native-thread', 'second', 'shared'),
      approval(903, 'native-thread', 'first', 'shared'),
      {
        ...approval(904, 'native-thread', 'second', 'shared'),
        method: 'item/commandExecution/requestApproval',
      },
    );
    const child = f.request(901);
    const second = f.request(902);
    const first = f.request(903);
    assert.deepEqual(child.diff, [
      {
        path: '/work/deleted.txt',
        kind: 'delete',
        hunks: [{ oldStart: 1, newStart: 0, lines: ['-deleted', '-tail'] }],
      },
    ]);
    assert.deepEqual(second.diff, [
      {
        path: '/work/created.txt',
        kind: 'add',
        hunks: [{ oldStart: 0, newStart: 1, lines: ['+created', '+last'] }],
      },
    ]);
    assert.deepEqual(first.diff, [
      {
        path: '/work/old.txt',
        movePath: '/work/moved.txt',
        kind: 'update',
        hunks: [
          {
            oldStart: 3,
            newStart: 3,
            lines: ['-before', '+after', ' context'],
          },
        ],
      },
    ]);
    assert.ok(
      f.events.some(
        (event) => event.type === 'tool' && event.diff === first.diff,
      ),
    );
    assert.ok(
      f.events.some(
        (event) => event.type === 'tool' && event.diff === second.diff,
      ),
    );
    assert.equal(f.request(904).diff, undefined);
    assert.equal(child.title, 'reason 901');
    assert.deepEqual(JSON.parse(child.detail), {
      threadId: 'child-thread',
      turnId: 'first',
      itemId: 'shared',
      startedAtMs: 1,
      reason: 'reason 901',
      grantRoot: '/work',
    });
    for (const [id, decision] of [
      [901, 'decline'],
      [902, 'accept'],
      [903, 'accept'],
    ] as const) {
      f.session.respond(String(id), { decision });
      assert.deepEqual(await f.receipt(id), { id, result: { decision } });
    }
  } finally {
    await close(f.session, f.cwd);
  }
});

await test('completed proposals cannot leak into a later approval', async () => {
  const f = await approvalsFixture();
  const changes = (name: string) => [
    { path: `/work/${name}.txt`, kind: { type: 'add' }, diff: `${name}\n` },
  ];
  try {
    await f.emit(
      proposal('native-thread', 'item-turn', 'item', changes('item-expired')),
      proposal('native-thread', 'ended-turn', 'ended', changes('turn-expired')),
      proposal(
        'native-thread',
        'pending-turn',
        'pending',
        changes('same-thread-pending'),
      ),
      proposal(
        'child-thread',
        'ended-turn',
        'ended',
        changes('other-thread-pending'),
      ),
      approval(910, 'native-thread', 'item-turn', 'item'),
    );
    const retained = f.request(910).diff;
    const before = structuredClone(retained);
    await f.emit(
      {
        method: 'item/completed',
        params: {
          threadId: 'native-thread',
          turnId: 'item-turn',
          item: {
            id: 'item',
            type: 'fileChange',
            status: 'completed',
            changes: changes('final-report'),
          },
        },
      },
      {
        method: 'turn/completed',
        params: {
          threadId: 'native-thread',
          turn: { id: 'ended-turn', status: 'completed', error: null },
        },
      },
      approval(911, 'native-thread', 'item-turn', 'item'),
      approval(912, 'native-thread', 'ended-turn', 'ended'),
      approval(913, 'native-thread', 'pending-turn', 'pending'),
      approval(914, 'child-thread', 'ended-turn', 'ended'),
      approval(915, 'native-thread', 'never-seen', 'pending'),
      {
        ...approval(916, 'native-thread', 'pending-turn', 'pending'),
        params: { itemId: 'pending' },
      },
    );
    assert.equal(f.request(911).diff, undefined);
    assert.equal(f.request(912).diff, undefined);
    assert.deepEqual(f.request(913).diff, [
      {
        path: '/work/same-thread-pending.txt',
        kind: 'add',
        hunks: [{ oldStart: 0, newStart: 1, lines: ['+same-thread-pending'] }],
      },
    ]);
    assert.deepEqual(f.request(914).diff, [
      {
        path: '/work/other-thread-pending.txt',
        kind: 'add',
        hunks: [{ oldStart: 0, newStart: 1, lines: ['+other-thread-pending'] }],
      },
    ]);
    assert.equal(f.request(915).diff, undefined);
    assert.equal(f.request(916).diff, undefined);
    assert.deepEqual(retained, before);
    assert.deepEqual(retained, [
      {
        path: '/work/item-expired.txt',
        kind: 'add',
        hunks: [{ oldStart: 0, newStart: 1, lines: ['+item-expired'] }],
      },
    ]);
    const completed = f.events.find(
      (event) => event.type === 'tool' && event.done && event.id === 'item',
    );
    assert.ok(completed?.type === 'tool');
    assert.equal(completed.diff?.[0]?.path, '/work/final-report.txt');
  } finally {
    await close(f.session, f.cwd);
  }
});
