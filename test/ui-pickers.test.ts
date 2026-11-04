import assert from 'node:assert/strict';
import { test } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement } from 'react';
import type { JobWatch } from '../src/core/jobs.js';
import { App } from '../src/ui/app.js';
import { fixture as coordinatorFixture } from './fixtures/coordinator.js';
import {
  show,
  forgedLink,
  fake,
  ENTER,
  SHIFT_ENTER,
  DOWN,
  openCommand,
  commands,
} from './fixtures/ui.js';
import { until, within } from './fixtures/within.js';

test('Escape during model refresh keeps chat usable', async () => {
  const { coordinator, a, b } = await coordinatorFixture();
  const entered = Promise.withResolvers<AbortSignal>();
  const aborted = Promise.withResolvers<void>();
  const discover = b.models.bind(b);
  const session = a.sessions[0]!.session;
  const ui = show(createElement(App, { coordinator, onExit: () => {} }));
  try {
    b.models = async (options) => {
      entered.resolve(options.signal!);
      options.signal!.addEventListener('abort', () => aborted.resolve(), {
        once: true,
      });
      await aborted.promise;
      options.signal!.throwIfAborted();
      return b.catalog;
    };
    await delay(60);
    ui.stdin.write('/model');
    await delay(30);
    ui.stdin.write(ENTER);
    const signal = await within(entered.promise, 2000, 'model discovery');
    await until('refresh activity', () =>
      ui.text().includes('ESC TO INTERRUPT'),
    );
    ui.stdin.write('\u001b');
    await until(
      'canceled refresh',
      () =>
        signal.aborted &&
        coordinator.snapshot.phase === 'idle' &&
        !ui.text().includes('ESC TO INTERRUPT'),
    );
    assert.equal(session.closed, false);
    assert.equal(coordinator.snapshot.error, undefined);
    assert.ok(!ui.text().includes('Models ·'), ui.text());
    assert.ok(!ui.text().includes('This operation was aborted'), ui.text());
    ui.stdin.write('after canceled refresh');
    await delay(30);
    ui.stdin.write(ENTER);
    await until(
      'next reply',
      () =>
        coordinator.snapshot.phase === 'idle' &&
        coordinator.snapshot.items.some(
          (item) => item.kind === 'assistant' && item.text === 'Done.',
        ),
    );
    assert.equal(a.sessions.length, 1);
    assert.equal(a.inputs.length, 1);
    assert.equal(a.inputs[0]!.session, session.info.id);
    assert.match(a.inputs[0]!.prompt, /^after canceled refresh$/);
    b.models = discover;
    await openCommand(ui, '/model', 'Models ·');
  } finally {
    ui.unmount();
    aborted.resolve();
    await coordinator.close();
  }
});

for (const [choice, keys, effort, outcome] of [
  ['Keep current effort', ENTER, undefined, 'without an effort'],
  ['a listed effort', `high${ENTER}`, 'high', 'with that effort'],
] as const)
  test(`/model with ${choice} selects the model ${outcome}`, async () => {
    const { app, calls } = fake({
      models: [
        { agent: 'a', id: 'm', label: 'Model M', efforts: ['low', 'high'] },
      ],
    });
    const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
    try {
      await delay(60);
      await openCommand(ui, '/model', 'Model M');
      await delay(30);
      ui.stdin.write(ENTER);
      await until('the effort picker', () =>
        ui.text().includes('Keep current effort'),
      );
      await delay(30);
      ui.stdin.write(keys);
      await until('the selection', () => calls.length === 2);
      assert.deepEqual(calls, [
        ['refreshModels'],
        ['selectModel', { agent: 'a', id: 'm', effort }],
      ]);
    } finally {
      ui.unmount();
    }
  });

test('a model id carrying a link sequence shows as plain text in the effort picker title', async () => {
  const { app } = fake({
    models: [
      {
        agent: 'a',
        id: forgedLink('x-evil:payload', 'm'),
        label: 'Model M',
        efforts: ['low', 'high'],
      },
    ],
  });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await delay(60);
    await openCommand(ui, '/model', 'Model M');
    await delay(30);
    ui.stdin.write(ENTER);
    await until('the effort picker', () =>
      ui.text().includes('Reasoning for m'),
    );
    assert.ok(
      !ui.frame().includes('\u001b]8;;x-evil'),
      JSON.stringify(ui.frame()),
    );
  } finally {
    ui.unmount();
  }
});

for (const typed of ['gpt-5.1', 'gpt-6'])
  test(`typing ${typed} in the model picker selects exactly it`, async () => {
    const { app, calls } = fake({
      models: ['gpt-5.1-codex', 'gpt-5.1'].map((id) => ({
        agent: 'a',
        id,
        label: id,
        efforts: [],
      })),
    });
    const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
    try {
      await delay(60);
      await openCommand(ui, '/model', 'gpt-5.1-codex');
      await delay(30);
      ui.stdin.write(`${typed}${ENTER}`);
      await until('the selection', () => calls.length === 2);
      assert.deepEqual(calls, [
        ['refreshModels'],
        ['selectModel', { agent: 'a', id: typed, effort: undefined }],
      ]);
    } finally {
      ui.unmount();
    }
  });

test('a long picker shows as many choices as its rows hold', async () => {
  const { app } = fake({
    models: Array.from({ length: 40 }, (_, n) => ({
      agent: 'a',
      id: `model-${n + 1}`,
      label: `model-${n + 1}`,
      efforts: [],
    })),
  });
  const ui = show(
    createElement(App, { coordinator: app, onExit: () => {} }),
    100,
    24,
  );
  try {
    await delay(60);
    await openCommand(ui, '/model', 'Models ·');
    const shown = ui
      .text()
      .split('\n')
      .filter((row) => row.trim().startsWith('a · model-'));
    // 24 rows less the phase row, title, filter, hint, the row every view leaves free and the status line's two
    assert.equal(shown.length, 17);
  } finally {
    ui.unmount();
  }
});

for (const [typed, call] of [
  ['/model m high', ['selectModel', { agent: 'a', id: 'm', effort: 'high' }]],
  ['/model b:m high', ['selectModel', { agent: 'b', id: 'm', effort: 'high' }]],
  ['/new b', ['newConversation', 'b']],
  [
    '/model vendor:model',
    ['selectModel', { agent: 'a', id: 'vendor:model', effort: undefined }],
  ],
  ['/agent b', ['send', '/agent b', { composer: true }]],
] as const)
  test(`${typed} passes its arguments`, async () => {
    const { app, calls } = fake({});
    const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
    try {
      await delay(60);
      ui.stdin.write(typed);
      await delay(30);
      ui.stdin.write(ENTER);
      await until('the call', () => calls.length > 0);
      assert.deepEqual(calls, [call]);
    } finally {
      ui.unmount();
    }
  });

test('/model with an ID only another runtime lists selects that runtime', async () => {
  const { app, calls } = fake({
    models: [{ agent: 'b', id: 'x', label: 'X', efforts: [] }],
  });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await delay(60);
    ui.stdin.write('/model x');
    await delay(30);
    ui.stdin.write(ENTER);
    await until('the call', () => calls.length > 0);
    assert.deepEqual(calls, [
      ['selectModel', { agent: 'b', id: 'x', effort: undefined }],
    ]);
  } finally {
    ui.unmount();
  }
});

for (const effort of ['low', undefined])
  test(`duplicate model IDs select the chosen runtime with ${effort ?? 'omitted'} effort`, async () => {
    const { app, calls } = fake({
      models: [
        { agent: 'a', id: 'shared', label: 'Same', efforts: ['high'] },
        { agent: 'b', id: 'shared', label: 'Same', efforts: ['low'] },
      ],
    });
    const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
    try {
      await delay(60);
      await openCommand(ui, '/model', 'b · Same');
      assert.match(ui.text(), /a · Same/);
      await delay(30);
      ui.stdin.write(DOWN);
      ui.stdin.write(ENTER);
      await until('destination effort', () =>
        ui.text().includes("Use b's current/default effort"),
      );
      assert.match(ui.text(), /low/);
      assert.doesNotMatch(ui.text(), /high/);
      await delay(30);
      ui.stdin.write(`${effort ?? ''}${ENTER}`);
      await until('selection', () => calls.length === 2);
      assert.deepEqual(calls, [
        ['refreshModels'],
        ['selectModel', { agent: 'b', id: 'shared', effort }],
      ]);
    } finally {
      ui.unmount();
    }
  });

test('closing the combined picker sends no selection and help advertises no agent command', async () => {
  const { app, calls } = fake({
    models: [{ agent: 'a', id: 'm', label: 'M', efforts: [] }],
  });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await delay(60);
    assert.match(ui.text(), /Use \/model/);
    await openCommand(ui, '/model', 'a · M');
    await delay(30);
    ui.stdin.write('\u001b');
    await until('picker closed', () => !ui.text().includes('Models ·'));
    assert.deepEqual(calls, [['refreshModels']]);
    await openCommand(ui, '/help', 'Keyboard help');
    assert.match(ui.text(), /\/model/);
    assert.doesNotMatch(ui.text(), /\/agent/);
    ui.stdin.write('\u001b');
    await delay(60);
    await commands(ui);
    assert.match(ui.text(), /Choose model and reasoning/);
    assert.doesNotMatch(ui.text(), /Switch agent/);
  } finally {
    ui.unmount();
  }
});

test('the composer stays closed while a second switch waits in the command queue and opens after both finish', async () => {
  const { coordinator, app, calls } = fake({});
  const switching = Promise.withResolvers<void>();
  coordinator.newConversation = async (...args: unknown[]) => {
    calls.push(['newConversation', ...args]);
    if (coordinator.snapshot.phase !== 'idle')
      throw new Error('Stop the current operation first');
    coordinator.publish({ phase: 'starting' });
    await switching.promise;
    coordinator.publish({ phase: 'idle' });
  };
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await delay(60);
    ui.stdin.write('/new b');
    await delay(30);
    ui.stdin.write(ENTER);
    await until('the switch', () => calls.length > 0);
    await delay(60);
    ui.stdin.write('hello');
    await delay(60);
    assert.ok(!ui.text().includes('┃ hello'));
    await commands(ui);
    ui.stdin.write(`new${ENTER}`);
    await delay(60);
    assert.deepEqual(calls, [['newConversation', 'b']]);
    assert.equal(coordinator.snapshot.commandsPending, true);
    await delay(60);
    ui.stdin.write('again');
    await delay(60);
    assert.ok(!ui.text().includes('┃ again'));
    coordinator.publish({
      conversation: { ...coordinator.snapshot.conversation!, id: 'c2' },
    });
    switching.resolve();
    await until(
      'both switches finish',
      () => !coordinator.snapshot.commandsPending,
    );
    assert.deepEqual(calls, [
      ['newConversation', 'b'],
      ['newConversation', undefined],
    ]);
    await delay(60);
    ui.stdin.write('there');
    await until('typing in the next conversation', () =>
      ui.text().includes('┃ there'),
    );
  } finally {
    switching.resolve();
    ui.unmount();
  }
});

test('a prompt sent in the same read as a switch stays in the draft of the conversation it was typed in', async () => {
  const { coordinator, app, calls } = fake({});
  const switching = Promise.withResolvers<void>();
  coordinator.newConversation = async (...args: unknown[]) => {
    calls.push(['newConversation', ...args]);
    coordinator.publish({ phase: 'starting' });
    await switching.promise;
  };
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await delay(60);
    ui.stdin.write(`/new b${ENTER}hello${ENTER}`);
    await until('the switch', () => calls.length > 0);
    await delay(60);
    assert.deepEqual(calls, [['newConversation', 'b']]);
    coordinator.publish({
      conversation: { ...coordinator.snapshot.conversation!, id: 'c2' },
      phase: 'idle',
    });
    switching.resolve();
    await until('the next conversation', () => !ui.text().includes('┃ hello'));
    coordinator.publish({
      conversation: { ...coordinator.snapshot.conversation!, id: 'c' },
    });
    await until('the kept draft', () => ui.text().includes('┃ hello'));
  } finally {
    switching.resolve();
    ui.unmount();
  }
});

test('the composer takes typing again once a switch fails', async () => {
  const { coordinator, app, calls } = fake({});
  coordinator.newConversation = async (...args: unknown[]) => {
    calls.push(['newConversation', ...args]);
    throw new Error('Prompts are still queued for this conversation');
  };
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await delay(60);
    ui.stdin.write('/new b');
    await delay(30);
    ui.stdin.write(ENTER);
    await until('the switch', () => calls.length > 0);
    await delay(60);
    ui.stdin.write('hello');
    await until('typing', () => ui.text().includes('┃ hello'));
  } finally {
    ui.unmount();
  }
});

for (const [name, keys] of [
  ['Down and Enter', DOWN + ENTER],
  ['a filter and Enter', `sess${ENTER}`],
  ['a filter, Down past it and Enter', `saved${DOWN}${ENTER}`],
] as const)
  test(`${name} in one read pick the selected command`, async () => {
    const { app, calls } = fake({});
    const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
    try {
      await delay(60);
      await commands(ui);
      ui.stdin.write(keys);
      await until('the conversations picker', () =>
        ui.text().includes('a · Other'),
      );
      await delay(30);
      ui.stdin.write(ENTER);
      await until('the selection', () => calls.length > 0);
      assert.deepEqual(calls, [['selectConversation', 'c2']]);
    } finally {
      ui.unmount();
    }
  });

test('a conversation picked in /sessions keeps the composer from typing until it opens', async () => {
  const { coordinator, app, calls } = fake({});
  const switching = Promise.withResolvers<void>();
  coordinator.selectConversation = async (...args: unknown[]) => {
    calls.push(['selectConversation', ...args]);
    coordinator.publish({ phase: 'starting' });
    await switching.promise;
  };
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await delay(60);
    await commands(ui);
    ui.stdin.write(`sess${ENTER}`);
    await until('the conversations picker', () =>
      ui.text().includes('a · Other'),
    );
    await delay(30);
    ui.stdin.write(ENTER);
    await until('the switch', () => calls.length > 0);
    await delay(60);
    ui.stdin.write('hello');
    await delay(60);
    assert.ok(!ui.text().includes('┃ hello'));
    coordinator.publish({
      conversation: { ...coordinator.snapshot.conversation!, id: 'c2' },
    });
    await delay(60);
    ui.stdin.write('there');
    await until('typing in the next conversation', () =>
      ui.text().includes('┃ there'),
    );
  } finally {
    switching.resolve();
    ui.unmount();
  }
});

test('/sessions tells same-titled conversations apart by when they last changed', async () => {
  const { coordinator, app, calls } = fake({});
  coordinator.conversations = async () => [
    {
      id: 'newer',
      title: "what's next?",
      agent: 'codex',
      cwd: '/work',
      modified: new Date(2026, 10, 3, 23, 46).getTime(),
    },
    {
      id: 'older',
      title: "what's next?",
      agent: 'codex',
      cwd: '/work',
      modified: new Date(2026, 0, 2, 8, 0).getTime(),
    },
  ];
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await delay(60);
    await commands(ui);
    ui.stdin.write(`sess${ENTER}`);
    await until('the conversations picker', () =>
      ui.text().includes("2026-01-02 08:00 · codex · what's next?"),
    );
    assert.ok(ui.text().includes("2026-11-03 23:46 · codex · what's next?"));
    ui.stdin.write(`01-02${ENTER}`);
    await until('the selection', () => calls.length > 0);
    assert.deepEqual(calls, [['selectConversation', 'older']]);
  } finally {
    ui.unmount();
  }
});

test('a filter resets the picker selection within the same read', async () => {
  const { app, calls } = fake({});
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await delay(60);
    await commands(ui);
    ui.stdin.write(`${DOWN}conv${ENTER}`);
    await until('the new conversation', () =>
      calls.some(([call]) => call === 'newConversation'),
    );
  } finally {
    ui.unmount();
  }
});

test('reopening the picker resets its selection', async () => {
  const { app, calls } = fake({});
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await delay(60);
    await commands(ui);
    ui.stdin.write(DOWN);
    await delay(30);
    ui.stdin.write('\u001b');
    await until('the chat view', () => !ui.text().includes('Commands'));
    await commands(ui);
    ui.stdin.write(ENTER);
    await until('the new conversation', () =>
      calls.some(([call]) => call === 'newConversation'),
    );
  } finally {
    ui.unmount();
  }
});

for (const sameRead of [false, true])
  test(
    sameRead
      ? 'reopening commands clears the filter before Enter in the same read'
      : 'reopening commands clears the visible filter and submits the first command',
    async () => {
      const { app, calls } = fake({});
      let exits = 0;
      const ui = show(
        createElement(App, {
          coordinator: app,
          onExit: () => exits++,
        }),
      );
      try {
        await delay(60);
        await commands(ui);
        ui.stdin.write('ex');
        await until(
          'the filtered Exit command',
          () =>
            ui.text().includes('Exit') &&
            !ui.text().includes('New conversation'),
        );
        if (sameRead) ui.stdin.write(`\u0010${ENTER}`);
        else {
          await commands(ui);
          await until('the full command list', () =>
            ui.text().includes('New conversation'),
          );
          assert.match(ui.text(), /Filter, then Enter/);
          ui.stdin.write(ENTER);
        }
        await until(
          'the command dispatch',
          () => exits > 0 || calls.length > 0,
        );
        assert.deepEqual(calls, [['newConversation', undefined]]);
        assert.equal(exits, 0);
      } finally {
        ui.unmount();
      }
    },
  );

test('/jobs lists each job on one row with its CPU, age and command, also after the terminal narrows, and stops the chosen group, reporting a stop that fails', async () => {
  const { app, calls } = fake({});
  const jobs: Pick<JobWatch, 'list' | 'stop'> = {
    list: async () => [
      {
        group: 4242,
        generation: 7,
        command: `node --import tsx test/screen.test.ts ${'x'.repeat(200)}`,
        cpu: 99.6,
        startedAt: Date.now() - 72_000_000,
      },
      {
        group: 4343,
        generation: 9,
        command: 'sleep 600',
        cpu: 0,
        startedAt: Date.now(),
      },
    ],
    stop: async ({ group, generation }) => {
      calls.push(['stop', group, generation]);
      throw new Error(`Job ${group} has not stopped.`);
    },
  };
  const ui = show(
    createElement(App, { coordinator: app, jobs, onExit: () => {} }),
  );
  try {
    await delay(60);
    await commands(ui);
    ui.stdin.write(`jobs${ENTER}`);
    // the row is cut to the picker's 98 cells with an ellipsis, and the 61 cells before the command's x's leave room for 36
    await until('the jobs picker', () =>
      ui
        .text()
        .includes(
          `100% CPU · 1200M00S · node --import tsx test/screen.test.ts ${'x'.repeat(36)}…`,
        ),
    );
    ui.resize(40);
    // narrowing the terminal cuts it again, to the 38 cells left
    await until('the narrowed picker', () =>
      ui
        .text()
        .includes(
          'choose one to stop\n  100% CPU · 1200M00S · node --import …',
        ),
    );
    ui.stdin.write(DOWN);
    await delay(30);
    ui.stdin.write(ENTER);
    await until('the report', () => calls.length > 1);
    assert.deepEqual(calls, [
      ['stop', 4343, 9],
      ['report', 'Error: Job 4343 has not stopped.'],
      [
        'notice',
        'Commands canceled. Retry explicitly: /jobs',
        undefined,
        false,
      ],
    ]);
    await until(
      'the chat view',
      () => !ui.text().includes('choose one to stop'),
    );
  } finally {
    ui.unmount();
  }
});

test('/jobs without jobs or with none listed says none are running', async () => {
  for (const jobs of [
    undefined,
    { list: async () => [], stop: async () => {} },
  ]) {
    const { app } = fake({});
    const ui = show(
      createElement(App, { coordinator: app, jobs, onExit: () => {} }),
    );
    try {
      await delay(60);
      await commands(ui);
      ui.stdin.write(`jobs${ENTER}`);
      await until('the empty picker', () =>
        ui.text().includes('No jobs are running'),
      );
    } finally {
      ui.unmount();
    }
  }
});

test('/jobs reports a list that fails', async () => {
  const { app, calls } = fake({});
  const jobs = {
    list: () => Promise.reject(new Error('ps failed')),
    stop: async () => {},
  };
  const ui = show(
    createElement(App, { coordinator: app, jobs, onExit: () => {} }),
  );
  try {
    await delay(60);
    await commands(ui);
    ui.stdin.write(`jobs${ENTER}`);
    await until('the report', () => calls.length > 0);
    assert.deepEqual(calls, [
      ['report', 'Error: ps failed'],
      [
        'notice',
        'Commands canceled. Retry explicitly: /jobs',
        undefined,
        false,
      ],
    ]);
  } finally {
    ui.unmount();
  }
});

test('/compact dispatches locally and discards surrounding prose without sending a prompt', async () => {
  const { app, calls } = fake({});
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await delay(60);
    ui.stdin.write('/compact');
    await delay(30);
    ui.stdin.write(ENTER);
    await until('local compaction', () => calls.length === 1);
    assert.deepEqual(calls, [['compact']]);
    ui.stdin.write('/compact instructions');
    await delay(30);
    ui.stdin.write(ENTER);
    await until('local compaction', () => calls.length === 2);
    assert.deepEqual(calls[1], ['compact']);
  } finally {
    ui.unmount();
  }
});

test('/compact discards multiline prose without sending a prompt', async () => {
  const { app, calls } = fake({});
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await delay(60);
    ui.stdin.write('/compact first');
    ui.stdin.write(SHIFT_ENTER);
    ui.stdin.write('second');
    await delay(30);
    ui.stdin.write(ENTER);
    await until('local compaction', () => calls.length > 0);
    assert.deepEqual(calls, [['compact']]);
  } finally {
    ui.unmount();
  }
});
