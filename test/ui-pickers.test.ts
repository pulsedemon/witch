import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement } from 'react';
import type { JobWatch } from '../src/core/jobs.js';
import { App } from '../src/ui/app.js';
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
import { until } from './fixtures/within.js';

for (const [choice, keys, effort, outcome] of [
  ['Keep current effort', ENTER, undefined, 'without an effort'],
  ['a listed effort', `high${ENTER}`, 'high', 'with that effort'],
] as const)
  await test(`/model with ${choice} selects the model ${outcome}`, async () => {
    const { app, calls } = fake({
      models: [{ id: 'm', label: 'Model M', efforts: ['low', 'high'] }],
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
        ['selectModel', 'm', effort],
      ]);
    } finally {
      ui.unmount();
    }
  });

await test('a model id carrying a link sequence shows as plain text in the effort picker title', async () => {
  const { app } = fake({
    models: [
      {
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
  await test(`typing ${typed} in the model picker selects exactly it`, async () => {
    const { app, calls } = fake({
      models: ['gpt-5.1-codex', 'gpt-5.1'].map((id) => ({
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
      assert.deepEqual(calls, [['refreshModels'], ['selectModel', typed]]);
    } finally {
      ui.unmount();
    }
  });

await test('a long picker shows as many choices as its rows hold', async () => {
  const { app } = fake({
    models: Array.from({ length: 40 }, (_, n) => ({
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
      .filter((row) => row.trim().startsWith('model-'));
    // 24 rows less the phase row, title, filter, hint, the row every view leaves free and the status line's two
    assert.equal(shown.length, 17);
  } finally {
    ui.unmount();
  }
});

for (const [typed, call] of [
  ['/model m high', ['selectModel', 'm', 'high']],
  ['/agent b', ['switchAgent', 'b']],
  ['/new b', ['newConversation', 'b']],
] as const)
  await test(`${typed} passes its arguments`, async () => {
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

await test('the composer takes no typing while a switch shows the conversation it leaves, also after a second switch is refused, and takes it once the next one opens', async () => {
  const { coordinator, app, calls } = fake({});
  const switching = Promise.withResolvers<void>();
  coordinator.newConversation = async (...args: unknown[]) => {
    calls.push(['newConversation', ...args]);
    if (coordinator.snapshot.phase !== 'idle')
      throw new Error('Stop the current operation first');
    coordinator.publish({ phase: 'starting' });
    await switching.promise;
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
    await until('the refused switch', () =>
      calls.some(([call]) => call === 'report'),
    );
    await delay(60);
    ui.stdin.write('again');
    await delay(60);
    assert.ok(!ui.text().includes('┃ again'));
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

await test('a prompt sent in the same read as a switch stays in the draft of the conversation it was typed in', async () => {
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

await test('the composer takes typing again once a switch fails', async () => {
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
  await test(`${name} in one read pick the selected command`, async () => {
    const { app, calls } = fake({});
    const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
    try {
      await delay(60);
      await commands(ui);
      ui.stdin.write(keys);
      await until('the conversations picker', () =>
        ui.text().includes('Other · a'),
      );
      await delay(30);
      ui.stdin.write(ENTER);
      await until('the selection', () => calls.length > 0);
      assert.deepEqual(calls, [['selectConversation', 'c2']]);
    } finally {
      ui.unmount();
    }
  });

await test('a conversation picked in /sessions keeps the composer from typing until it opens', async () => {
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
      ui.text().includes('Other · a'),
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

await test('a filter resets the picker selection within the same read', async () => {
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

await test('reopening the picker resets its selection', async () => {
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

await test('/jobs lists each job on one row with its CPU, age and command, also after the terminal narrows, and stops the chosen group, reporting a stop that fails', async () => {
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
    ]);
    await until(
      'the chat view',
      () => !ui.text().includes('choose one to stop'),
    );
  } finally {
    ui.unmount();
  }
});

await test('/jobs without jobs or with none listed says none are running', async () => {
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

await test('/jobs reports a list that fails', async () => {
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
    assert.deepEqual(calls, [['report', 'Error: ps failed']]);
  } finally {
    ui.unmount();
  }
});

await test('/compact dispatches a local operation and refuses arguments without sending a prompt', async () => {
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
    await until('argument refusal', () => calls.length === 2);
    assert.equal(calls[1]![0], 'report');
    assert.match(String(calls[1]![1]), /\/compact without arguments/);
  } finally {
    ui.unmount();
  }
});

await test('/compact refuses multiline arguments without sending a prompt', async () => {
  const { app, calls } = fake({});
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await delay(60);
    ui.stdin.write('/compact first');
    ui.stdin.write(SHIFT_ENTER);
    ui.stdin.write('second');
    await delay(30);
    ui.stdin.write(ENTER);
    await until('argument refusal', () => calls.length > 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]![0], 'report');
    assert.match(String(calls[0]![1]), /\/compact without arguments/);
  } finally {
    ui.unmount();
  }
});
