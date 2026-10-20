import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import { createElement } from 'react';
import type { CoordinationSnapshot } from '../src/core/coordination-state.js';
import { callControl } from '../src/persistence/control.js';
import { App } from '../src/ui/app.js';
import { TurnGate } from './fixtures/agent.js';
import { coordinationFixture, git } from './fixtures/coordination.js';
import { fake, forgedLink, show } from './fixtures/ui.js';
import { until, within } from './fixtures/within.js';

function peer(index: number): CoordinationSnapshot['peers'][number] {
  return {
    presence: {
      version: 1,
      id: `peer-${index}`,
      title: `Conversation ${index}`,
      cwd: `/work/checkout-${index}`,
      agent: `agent-${index}`,
      project: 'project',
      activation: randomUUID(),
      process: { pid: 123, started: 'Tue Oct 20 01:00:00 2026' },
      phase: 'idle',
      requests: index === 3 ? 1 : 0,
      familiars: 0,
      brews: 0,
      branch: `branch-${index}`,
      openedAt: index,
      updatedAt: 1,
    },
    claim: {
      id: randomUUID(),
      owner: { conversation: `peer-${index}`, project: 'project' },
      summary: `Task ${index}`,
      references: [`github:example/demo#${index + 1}`],
      createdAt: 1,
    },
  };
}

function peersApp(initial: CoordinationSnapshot) {
  const { app, coordinator, calls } = fake({});
  const listeners = new Set<() => void>();
  const coordination = {
    snapshot: initial,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  Object.assign(coordinator, { coordination });
  return {
    app,
    coordinator,
    calls,
    publish(snapshot: CoordinationSnapshot) {
      coordination.snapshot = snapshot;
      for (const listener of listeners) listener();
    },
  };
}

const snapshot = (
  peers: CoordinationSnapshot['peers'],
): CoordinationSnapshot => ({
  peers,
  reservations: [],
  unregistered: [],
});
const sidebar = (text: string) =>
  text.split('\n').map((row) => row.slice(82).trimEnd());
const enter = (ui: ReturnType<typeof show>, text: string) => {
  ui.stdin.write(text);
  ui.stdin.write('\x1b[13u');
};

await test('peer sidebar uses the task, agent, actual status and linked checkout on two rows and removes its empty heading', async () => {
  const claimed = peer(3),
    unclaimed = peer(1);
  delete unclaimed.claim;
  const fixture = peersApp(snapshot([claimed, unclaimed]));
  const ui = show(
    createElement(App, { coordinator: fixture.app, onExit() {} }),
    115,
    30,
  );
  try {
    await until('peer rows', () => ui.text().includes('SESSIONS'));
    assert.deepEqual(sidebar(ui.text()).slice(0, 5), [
      'SESSIONS',
      'Task 3',
      'agent-3 | waiting | checkout-3',
      'Conversation 1 (unclaimed)',
      'agent-1 | idle | checkout-1',
    ]);
    assert.ok(ui.frame().includes('https://github.com/example/demo/issues/4'));
    assert.ok(ui.frame().includes('vscode://file/work/checkout-3'));
    fixture.publish(snapshot([]));
    await until('empty heading removed', () => !ui.text().includes('SESSIONS'));
  } finally {
    ui.unmount();
  }
});

for (const [height, expected] of [
  [
    23,
    [
      'SESSIONS',
      '+2 MORE',
      'Task 2',
      'agent-2 | idle | checkout-2',
      'Task 3',
      'agent-3 | waiting | checkout-3',
      'Task 4',
      'agent-4 | idle | checkout-4',
      'BREWS',
      '+3 MORE',
      'FAMILIARS',
      '+1 MORE',
    ],
  ],
  [
    19,
    [
      'SESSIONS',
      '+4 MORE',
      'Task 4',
      'agent-4 | idle | checkout-4',
      'BREWS',
      '+3 MORE',
      'FAMILIARS',
      '+1 MORE',
    ],
  ],
  [16, ['BREWS', '+2 MORE', '● BREW 3', 'FAMILIARS', '+1 MORE']],
] as const) {
  await test(`at ${height} rows peers preserve local group counts and the whole pentacle`, async () => {
    const fixture = peersApp(snapshot([0, 1, 2, 3, 4].map(peer)));
    fixture.coordinator.publish({
      backgroundCommands: [1, 2, 3].map((i) => ({
        id: String(i),
        description: `brew ${i}`,
        status: 'running' as const,
      })),
      subagents: [
        {
          id: 'f',
          name: 'local familiar',
          kind: 'review',
          status: 'running',
          startedAt: Date.now(),
          rows: { start: 's' },
        },
      ],
    });
    const ui = show(
      createElement(App, { coordinator: fixture.app, onExit() {} }),
      115,
      height,
    );
    try {
      await until('sidebar frame', () =>
        /[⠁-⣿]/.test(sidebar(ui.text()).join('')),
      );
      const rows = sidebar(ui.text());
      assert.deepEqual(rows.slice(0, height - 11), expected);
      assert.ok(
        rows.slice(height - 11, height).every((row) => /[⠁-⣿]/.test(row)),
        rows.join('\n'),
      );
    } finally {
      ui.unmount();
    }
  });
}

await test('peer labels cannot insert extra rows or forged terminal links', async () => {
  const changed = peer(2);
  changed.claim!.summary = forgedLink('x-evil:task', 'Title') + '\nnext';
  changed.presence.agent = 'agent\nname';
  const fixture = peersApp(snapshot([changed]));
  const ui = show(
    createElement(App, { coordinator: fixture.app, onExit() {} }),
    115,
    25,
  );
  try {
    await until('peer shown', () => ui.text().includes('SESSIONS'));
    assert.ok(sidebar(ui.text())[1]!.startsWith('Title'));
    assert.match(sidebar(ui.text())[2]!, /^agent name \| idle \| checkout-2/);
    assert.ok(!ui.frame().includes('\x1b]8;;x-evil'));
  } finally {
    ui.unmount();
  }
});

await test('the narrow peers page stays live and read-only during work and describes reservations without invented session fields', async () => {
  const first = peer(0),
    outside = peer(1).claim!,
    legacy = peer(2).presence;
  const fixture = peersApp({
    ...snapshot([first]),
    reservations: [{ claim: outside, status: 'owner-outside-project' }],
    unregistered: [legacy],
  });
  fixture.coordinator.publish({ phase: 'running' });
  const ui = show(
    createElement(App, { coordinator: fixture.app, onExit() {} }),
    100,
    40,
  );
  try {
    enter(ui, '/peers');
    await until('peer details', () =>
      ui.text().includes('Repository sessions'),
    );
    assert.ok(!ui.text().includes('SESSIONS'));
    assert.ok(ui.text().includes('branch-0'));
    assert.ok(ui.text().includes('/work/checkout-0'));
    assert.ok(ui.text().includes('owner outside project'));
    assert.ok(ui.text().includes('Conversation 2 | unregistered'));
    assert.ok(!ui.text().includes('branch-1'));
    assert.ok(!ui.text().includes('/work/checkout-1'));
    assert.deepEqual(fixture.calls, []);
    fixture.publish({
      ...snapshot([]),
      reservations: [{ claim: first.claim!, status: 'unattended' }],
    });
    await until(
      'live reservation',
      () => ui.text().includes('unattended') && !ui.text().includes('branch-0'),
    );
    assert.ok(ui.text().includes(first.claim!.id));
    fixture.publish({ ...snapshot([]), error: 'Unreadable ownership' });
    await until('unavailable', () =>
      ui.text().includes('Coordination unavailable: Unreadable ownership'),
    );
    assert.deepEqual(fixture.calls, []);
  } finally {
    ui.unmount();
  }
});

await test('a real peer updates its summary, leaves the sidebar after an origin change, and keeps its reservation on the open page', async (t) => {
  const { root, start, registry } = await coordinationFixture(t);
  const a = await start(),
    b = await start('B');
  await start('C');
  await a.claim('task:original', 'Owner task');
  const owned = (await registry.claims())[0]!;
  const ui = show(
    createElement(App, { coordinator: b.coordinator, onExit() {} }),
    115,
    30,
  );
  try {
    await until('real sidebar', () => ui.text().includes('Owner task'));
    assert.ok(!sidebar(ui.text()).join('\n').includes(' | C'));
    enter(ui, '/peers');
    await until('open page', () => ui.text().includes('Repository sessions'));
    await a.claim('task:original', 'Updated live task');
    await until('live summary', () => ui.text().includes('Updated live task'));
    await git(
      '-C',
      join(root, 'A'),
      'remote',
      'set-url',
      'origin',
      join(root, 'other'),
    );
    assert.equal((await a.claim('task:different')).kind, 'error');
    await until(
      'outside owner',
      () =>
        ui.text().includes('owner outside project') &&
        !sidebar(ui.text()).join('\n').includes('Updated live task'),
    );
    assert.equal((await b.query()).reservations[0]!.claim.id, owned.id);
    ui.resize(100);
    await until(
      'narrow same claim',
      () => !ui.text().includes('SESSIONS') && ui.text().includes(owned.id),
    );
    await a.coordinator.close();
    await until('owner removed live', () => ui.text().includes('unattended'));
    assert.ok(ui.text().includes('Updated live task'));
  } finally {
    ui.unmount();
  }
});

await test('task release refuses running or background work without changing phase, and then releases only this conversation', async (t) => {
  const { start, registry } = await coordinationFixture(t);
  const a = await start(),
    b = await start('B');
  await a.claim('task:mine', 'My current task');
  await b.claim('task:theirs', 'Other current task');
  const own = (await a.query()).ownClaim!;
  const ui = show(
    createElement(App, { coordinator: a.coordinator, onExit() {} }),
    100,
    30,
  );
  const gate = new TurnGate();
  a.a.gate = gate;
  const sending = a.coordinator.send('Held work');
  try {
    await within(gate.entered, 5000, 'held turn');
    enter(ui, '/task release');
    await until('idle refusal', () => ui.text().includes('Wait for idle'));
    assert.equal(a.coordinator.snapshot.phase, 'running');
    assert.deepEqual((await a.query()).ownClaim, own);
    gate.open();
    await sending;
    ui.stdin.write('\x1b');
    await until('chat again', () => !ui.text().includes('Current task'));
    a.a.sessions.at(-1)!.options.onEvent({
      type: 'command',
      command: { id: 'brew', description: 'Work', status: 'running' },
    });
    enter(ui, '/task release');
    await until('background refusal', () =>
      ui.text().includes('Stop the running familiars'),
    );
    assert.equal(a.coordinator.snapshot.phase, 'idle');
    assert.deepEqual((await a.query()).ownClaim, own);
    a.a.sessions.at(-1)!.options.onEvent({
      type: 'command',
      command: { id: 'brew', description: 'Work', status: 'completed' },
    });
    ui.stdin.write('\x1b');
    await until('chat restored', () => !ui.text().includes('Current task'));
    enter(ui, '/task release');
    await until('released own', () => ui.text().includes('No task claimed.'));
    assert.deepEqual(
      (await registry.claims()).map((c) => c.summary),
      ['Other current task'],
    );
    assert.equal(
      (await callControl(await b.binding(), { kind: 'peers' })).kind,
      'peers',
    );
  } finally {
    gate.open();
    await sending;
    ui.unmount();
  }
});
