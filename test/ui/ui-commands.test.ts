import assert from 'node:assert/strict';
import { createElement } from 'react';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'vitest';
import { App } from '../../src/ui/App.js';
import { parseCommands } from '../../src/ui/commands/commands.js';
import type { WitchCommand } from '../../src/ui/commands/commands.js';
import type { StateStore } from '../../src/persistence/store.js';
import { unitFixture } from '../fixtures/coordinator.js';
import { TurnGate } from '../fixtures/agent.js';
import { show, fake, prompts, ENTER, UP } from '../fixtures/ui.js';
import { until } from '../fixtures/within.js';

const cases: [string, WitchCommand[] | undefined][] = [
  ['/compact', [{ name: 'compact', argument: '' }]],
  [
    'please /compact then /model fable',
    [
      { name: 'compact', argument: '' },
      { name: 'model', argument: 'fable' },
    ],
  ],
  ['how do i use /model', [{ name: 'model', argument: '' }]],
  [
    '/new claude /model a:large high /task take task:work /clear rest',
    [
      { name: 'new', argument: 'claude' },
      { name: 'model', argument: 'a:large high' },
      { name: 'task', argument: 'take task:work' },
      { name: 'clear', argument: '' },
    ],
  ],
  [' /quit ', [{ name: 'exit', argument: '' }]],
  [
    '/compact first\nsecond /clear third',
    [
      { name: 'compact', argument: '' },
      { name: 'clear', argument: '' },
    ],
  ],
  ['`/clear` then /compact', [{ name: 'compact', argument: '' }]],
  [
    '```text\n/clear\n```\n/model fable',
    [{ name: 'model', argument: 'fable' }],
  ],
  ['``literal `/clear` text`` /compact', [{ name: 'compact', argument: '' }]],
  ['`unclosed /clear /model', undefined],
  ['```\n/compact\n', undefined],
  ['/compactly /unknown /path/clear prefix/clear /clear,', undefined],
  ['! printf /clear /compact', undefined],
  ['/audit please /clear /compact', undefined],
  ['prose /audit /clear', undefined],
  ['why does /clear keep the transcript?', undefined],
  ['rename the /exit command', undefined],
  ['please /compact and /clear', [{ name: 'compact', argument: '' }]],
  [
    'please /model fable then /new',
    [{ name: 'model', argument: 'fable then' }],
  ],
  [
    '/review a.md /clear',
    [
      { name: 'review', argument: 'a.md' },
      { name: 'clear', argument: '' },
    ],
  ],
  [
    '/compact /model fable',
    [
      { name: 'compact', argument: '' },
      { name: 'model', argument: 'fable' },
    ],
  ],
];

for (const [text, expected] of cases)
  test(`command parsing: ${JSON.stringify(text)}`, () => {
    assert.deepEqual(
      parseCommands(text, [
        { name: 'audit', description: 'Native audit' },
        { name: 'compact', description: 'Native name collision' },
      ]),
      expected,
    );
  });

async function submit(ui: ReturnType<typeof show>, text: string) {
  ui.stdin.write(text);

  await delay(30);

  ui.stdin.write(ENTER);
}

test('embedded commands finish compaction and model application before queued prose, with a visible pending row at minimum size', async () => {
  const f = await unitFixture(),
    c = f.coordinator,
    gate = new TurnGate();

  const ui = show(
    createElement(App, { coordinator: c, onExit: () => {} }),
    80,
    24,
  );

  try {
    await delay(70);

    f.a.gate = gate;
    const parent = c.send('original parent');

    await gate.entered;

    await submit(ui, 'please /compact then /model a-big high');

    await until('pending row', () => ui.text().includes('Pending: /compact'));

    ui.resize(30);

    await until('pending row after resize', () =>
      ui.text().includes('Pending: /compact'),
    );

    await submit(ui, 'exact later prompt');

    await until('queued prose', () => c.snapshot.queue.length === 1);

    assert.deepEqual(f.a.steers, []);

    assert.deepEqual(f.a.selections, []);

    const native = f.a.sessions[0]!.session,
      send = native.send.bind(native);

    const received: unknown[][] = [];

    native.send = (...args) => {
      received.push([args[0], native.info.model, native.info.effort]);

      return send(...args);
    };

    gate.open();

    await parent;

    await until(
      'command batch and queued prompt',
      () => c.snapshot.phase === 'idle' && f.a.inputs.length === 2,
    );

    assert.deepEqual(received, [['exact later prompt', 'a-big', 'high']]);

    assert.equal(c.snapshot.commandsPending, false);

    assert.equal(c.snapshot.pendingCompaction, false);

    assert.equal(f.a.compactions.length, 1);
  } finally {
    gate.open();

    ui.unmount();

    await c.close();
  }
});

test('model and nested effort selection include native application before the following command', async () => {
  const { app, coordinator, calls } = fake({
    models: [{ agent: 'a', id: 'large', label: 'Large', efforts: ['high'] }],
  });

  const applied = Promise.withResolvers<void>();

  coordinator.selectModel = async (...args: unknown[]) => {
    calls.push(['selectModel', ...args]);

    await applied.promise;
  };

  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));

  try {
    await delay(70);

    await submit(ui, '/model /compact');

    await until('model picker', () => ui.text().includes('Models ·'));

    ui.stdin.write(ENTER);

    await until('effort picker', () =>
      ui.text().includes('Reasoning for large'),
    );

    assert.deepEqual(calls, [['refreshModels']]);

    await submit(ui, 'high');

    await until('model applying', () => calls.length === 2);

    assert.equal(coordinator.snapshot.commandsPending, true);

    assert.equal(
      calls.some(([name]) => name === 'compact'),
      false,
    );

    applied.resolve();

    await until(
      'compact after native model application',
      () => !coordinator.snapshot.commandsPending,
    );

    assert.deepEqual(calls, [
      ['refreshModels'],
      ['selectModel', { agent: 'a', id: 'large', effort: 'high' }],
      ['compact'],
    ]);
  } finally {
    applied.resolve();

    ui.unmount();
  }
});

for (const key of ['\u001b', '\u0010'])
  test(`${key === '\u001b' ? 'Escape dismissal' : 'Ctrl+P replacement'} settles a picker before its command suffix`, async () => {
    const { app, coordinator, calls } = fake({});
    const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));

    try {
      await delay(70);

      await submit(ui, '/model /compact');

      await until('model picker', () => ui.text().includes('Models ·'));

      ui.stdin.write(key);

      await until(
        'suffix completes',
        () =>
          calls.some(([name]) => name === 'compact') &&
          !coordinator.snapshot.commandsPending,
      );

      assert.deepEqual(calls, [['refreshModels'], ['compact']]);

      if (key === '\u0010') {
        // the Commands picker that replaced Models stays open through the suffix
        assert.ok(ui.text().includes('Commands'));

        ui.stdin.write('\u001b');

        await until('chat', () => !ui.text().includes('Commands'));
      }

      await submit(ui, '/clear');

      await until('next explicit batch', () =>
        calls.some(([name]) => name === 'clear'),
      );
    } finally {
      ui.unmount();
    }
  });

for (const [draft, between] of [
  ['', false],
  ['', true],
  ['/clear', false],
  ['! printf /compact', false],
] as const)
  test(`canceling two batches preserves ordinary input ${between ? 'between batches' : 'after batches'} and draft ${JSON.stringify(draft)}`, async () => {
    const f = await unitFixture(),
      c = f.coordinator,
      gate = new TurnGate();

    const history = prompts([]);

    const ui = show(
      createElement(App, {
        coordinator: c,
        store: history.store as unknown as StateStore,
        onExit: () => {},
      }),
    );

    let cleared = 0;
    const clear = c.clear.bind(c);

    c.clear = async () => {
      cleared++;

      await clear();
    };

    try {
      await delay(70);

      f.a.gate = gate;
      const parent = c.send('ordinary parent');

      await gate.entered;

      await submit(ui, '/compact');

      await until('compact admitted', () => c.snapshot.pendingCompaction);

      if (between) await submit(ui, 'fix the failing test');

      await submit(ui, '/clear');

      if (!between) await submit(ui, 'fix the failing test');

      await until('ordinary queue', () => c.snapshot.queue.length === 1);

      if (draft) ui.stdin.write(draft);

      await delay(40);

      ui.stdin.write('\u0003');

      await parent;

      await until(
        'cancel settled',
        () =>
          c.snapshot.phase === 'idle' &&
          !c.snapshot.commandsPending &&
          !c.snapshot.pendingCompaction,
      );

      await delay(70);

      assert.equal(cleared, 0);

      assert.deepEqual(f.a.steers, []);

      const notices = c.snapshot.items.filter((i) =>
        i.text.startsWith('Commands canceled.'),
      );

      assert.deepEqual(
        notices.map((i) => i.text),
        ['Commands canceled. Retry explicitly: /compact; /clear'],
      );

      assert.deepEqual(
        history.added.map(([, text]) => text),
        between
          ? ['/compact', 'fix the failing test', '/clear']
          : ['/compact', '/clear', 'fix the failing test'],
      );

      if (draft) {
        assert.deepEqual(c.snapshot.queue, ['fix the failing test']);

        ui.stdin.write(UP);

        await delay(40);

        assert.deepEqual(c.snapshot.queue, ['fix the failing test']);

        for (let i = draft.length; i > 0; i--) {
          ui.stdin.write('\u007f');

          await delay(15);

          if (i > 1)
            assert.deepEqual(c.snapshot.queue, ['fix the failing test']);
        }
      }

      await until(
        'safe recovery',
        () =>
          !c.snapshot.queue.length &&
          ui.text().includes('┃ fix the failing test'),
      );

      f.a.gate = undefined;

      ui.stdin.write(ENTER);

      await until(
        'recovered prose delivered',
        () => f.a.inputs.length === 2 && c.snapshot.phase === 'idle',
      );

      assert.equal(f.a.inputs[1]!.prompt, 'fix the failing test');

      assert.equal(cleared, 0);

      await submit(ui, '/clear');

      await until(
        'explicit command retry',
        () => cleared === 1 && !c.snapshot.commandsPending,
      );
    } finally {
      gate.open();

      ui.unmount();

      await c.close();
    }
  });

for (const failure of ['native', 'refusal'] as const)
  test(`${failure} failure flushes a separately submitted command batch and preserves its exact retry arguments`, async () => {
    const { app, coordinator, calls } = fake({
      phase: failure === 'refusal' ? 'running' : 'idle',
    });

    const stopped = Promise.withResolvers<boolean>();

    coordinator.compact = async () => {
      calls.push(['compact']);

      return stopped.promise;
    };

    coordinator.newConversation = async (...args: unknown[]) => {
      calls.push(['newConversation', ...args]);

      await stopped.promise;

      throw new Error('Stop the current operation first');
    };

    const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
    const first = failure === 'native' ? '/compact' : '/new b';

    try {
      await delay(70);

      await submit(ui, first);

      await submit(ui, '/model a-big high /clear');

      stopped.resolve(false);

      await until(
        'all holds released',
        () => !coordinator.snapshot.commandsPending,
      );

      assert.equal(
        calls.some(([name]) => name === 'selectModel' || name === 'clear'),
        false,
      );

      assert.deepEqual(
        calls.filter(([name]) => name === 'notice'),
        [
          [
            'notice',
            `Commands canceled. Retry explicitly: ${first}; /model a-big high; /clear`,
            undefined,
            false,
          ],
        ],
      );

      await submit(ui, '/clear');

      await until('fresh explicit batch', () =>
        calls.some(([name]) => name === 'clear'),
      );
    } finally {
      stopped.resolve(false);

      ui.unmount();
    }
  });

test('unsafe queued-message merging retains native shell boundaries until an explicit ordinary submission', async () => {
  const f = await unitFixture(),
    c = f.coordinator,
    gate = new TurnGate();

  const ui = show(createElement(App, { coordinator: c, onExit: () => {} }));

  try {
    await delay(70);

    f.a.gate = gate;
    const parent = c.send('original');

    await gate.entered;

    await submit(ui, '/compact');

    await until('pending compact', () => c.snapshot.pendingCompaction);

    await submit(ui, 'queued prose');

    await submit(ui, '! printf /compact');

    await until(
      'separate queued messages',
      () => c.snapshot.queue.length === 2,
    );

    ui.stdin.write('\u0003');

    await parent;

    await until(
      'cancel completes',
      () => !c.snapshot.commandsPending && !c.snapshot.pendingCompaction,
    );

    await until('truthful queue hint', () =>
      ui.text().includes('Messages remain queued'),
    );

    assert.equal(ui.text().includes('Press ↑ to edit queued messages'), false);

    ui.stdin.write(UP);

    await delay(50);

    assert.deepEqual(c.snapshot.queue, ['queued prose', '! printf /compact']);

    f.a.gate = undefined;
    f.a.refuseSteer = true;

    await submit(ui, 'explicit continuation');

    await until(
      'original messages delivered',
      () =>
        c.snapshot.phase === 'idle' &&
        !c.snapshot.queue.length &&
        f.a.inputs.at(-1)?.prompt === 'explicit continuation',
    );

    assert.deepEqual(f.a.shells, [' printf /compact']);

    assert.equal(f.a.inputs[1]!.prompt, 'queued prose');

    assert.equal(f.a.inputs.length, 4);
  } finally {
    gate.open();

    ui.unmount();

    await c.close();
  }
});

test('/review hands its files to the coordinator, and a failed review cancels the commands after it', async () => {
  const { app, coordinator, calls } = fake({});
  const results = [false, true];

  Object.assign(coordinator, {
    review: async (argument: string) => {
      calls.push(['review', argument]);

      return results.shift();
    },
  });

  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));

  try {
    await delay(70);

    await submit(ui, '/review a.md docs/b.md /clear');

    await until('the canceled batch', () =>
      calls.some(
        ([name, text]) =>
          name === 'notice' &&
          text ===
            'Commands canceled. Retry explicitly: /review a.md docs/b.md; /clear',
      ),
    );

    assert.ok(!calls.some(([name]) => name === 'clear'));

    await submit(ui, '/review a.md /clear');

    await until('the next batch', () =>
      calls.some(([name]) => name === 'clear'),
    );

    assert.deepEqual(
      calls.filter(([name]) => name === 'review' || name === 'clear'),
      [['review', 'a.md docs/b.md'], ['review', 'a.md'], ['clear']],
    );
  } finally {
    ui.unmount();
  }
});

test('/help draws its section headings in bold violet', async () => {
  const { app } = fake({});
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));

  try {
    await delay(60);

    await submit(ui, '/help');

    await until('the help page', () => ui.text().includes('COMPOSER'));

    assert.ok(ui.frame().includes('\u001b[38;2;168;85;247m\u001b[1mCOMMANDS'));
  } finally {
    ui.unmount();
  }
});

test('a page an earlier command in a batch opened stays open while a later one runs, and a later picker replaces it', async () => {
  const { app, coordinator, calls } = fake({});
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));

  try {
    await delay(60);

    await submit(ui, '/help /compact');

    await until(
      'compact',
      () =>
        calls.some(([name]) => name === 'compact') &&
        !coordinator.snapshot.commandsPending,
    );

    await delay(60);

    assert.ok(ui.text().includes('COMPOSER'), 'help after /compact ran');

    ui.stdin.write('\u001b');

    await until('chat', () => !ui.text().includes('COMPOSER'));

    await submit(ui, '/help /model');

    await until('the model picker', () => ui.text().includes('Models ·'));
  } finally {
    ui.unmount();
  }
});
