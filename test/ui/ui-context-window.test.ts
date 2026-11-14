import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createElement } from 'react';
import { App } from '../../src/ui/App.js';
import { chooseModel } from '../../src/ui/commands/model-choice.js';
import { show, fake, ENTER, DOWN } from '../fixtures/ui.js';
import { until } from '../fixtures/within.js';

async function openModels(ui: ReturnType<typeof show>, command = '/model') {
  await until('composer ready', () =>
    ui.text().includes('Ask the agent, or type /help'),
  );

  ui.stdin.write(command);

  await until('command rendered', () => ui.text().includes(command));

  ui.stdin.write(ENTER);

  await until('model picker', () => ui.text().includes('Model M'));
}

for (const [saved, choice, keys] of [
  [undefined, 'default', ENTER],
  [undefined, 'maximum', `${DOWN}${ENTER}`],
  ['maximum', 'maximum', ENTER],
] as const)
  test(`/model applies ${choice} with saved mode ${saved ?? 'unset'} after the capacity picker`, async () => {
    const { app, calls, coordinator } = fake({
      models: [
        {
          agent: 'a',
          id: 'm',
          label: 'Model M',
          efforts: ['high'],
          contextWindows: { default: 258400, maximum: 828400 },
        },
      ],
    });

    if (saved)
      coordinator.snapshot.conversation!.sessions.a = {
        id: 'n',
        model: 'm',
        hasHistory: true,
        contextWindow: saved,
      };

    const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));

    try {
      await openModels(ui);

      ui.stdin.write(ENTER);

      await until('effort picker', () =>
        ui.text().includes('Keep current effort'),
      );

      ui.stdin.write(ENTER);

      await until('context picker', () =>
        ui.text().includes('Context window for m'),
      );

      assert.match(ui.text(), /Default \(258\.4K\)/);

      assert.match(ui.text(), /Maximum \(828\.4K\)/);

      assert.deepEqual(calls, [['refreshModels']]);

      ui.stdin.write(keys);

      await until('complete model selection', () => calls.length === 2);

      assert.deepEqual(calls[1], [
        'selectModel',
        { agent: 'a', id: 'm', effort: undefined, contextWindow: choice },
      ]);
    } finally {
      ui.unmount();
    }
  });

test('Escape from the Codex window picker changes no selection and completes dismissal', async () => {
  const { app, calls, coordinator } = fake({
    models: [
      {
        agent: 'a',
        id: 'm',
        label: 'Model M',
        efforts: [],
        contextWindows: { default: 258400, maximum: 828400 },
      },
    ],
  });

  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));

  try {
    await openModels(ui, '/model /clear');

    ui.stdin.write(ENTER);

    await until('context picker', () =>
      ui.text().includes('Context window for m'),
    );

    ui.stdin.write('\u001b');

    await until(
      'context picker dismissed',
      () => !ui.text().includes('Context window for m'),
    );

    await until(
      'clear completed and batch released',
      () =>
        calls.some(([name]) => name === 'clear') &&
        !coordinator.snapshot.commandsPending,
    );

    assert.deepEqual(calls, [['refreshModels'], ['clear']]);
  } finally {
    ui.unmount();
  }
});

test('a Codex choice on another runtime collects its window before a single handoff selection', async () => {
  const { app, calls } = fake({
    models: [
      {
        agent: 'b',
        id: 'm',
        label: 'Model M',
        efforts: [],
        contextWindows: { default: 258400, maximum: 828400 },
      },
    ],
  });

  await chooseModel(
    {
      coordinator: app,
      picker: async (title, choices, choose) => {
        assert.equal(title, 'Context window for m');

        assert.deepEqual(calls, []);

        assert.deepEqual(
          choices.map((choice) => choice.label),
          ['Default (258.4K)', 'Maximum (828.4K)'],
        );

        await choose('maximum');

        return true;
      },
      toChat: (handoff) => assert.equal(handoff, true),
    },
    'b:m',
    undefined,
    () => true,
  );

  assert.deepEqual(calls, [
    [
      'selectModel',
      { agent: 'b', id: 'm', effort: undefined, contextWindow: 'maximum' },
    ],
  ]);
});

for (const windows of [undefined, { default: 258400, maximum: 258400 }])
  test(`a model with ${windows ? 'equal' : 'missing'} context capacities opens no extra picker`, async () => {
    const { app, calls } = fake({
      models: [
        {
          agent: 'a',
          id: 'm',
          label: 'Model M',
          efforts: [],
          contextWindows: windows,
        },
      ],
    });

    await chooseModel(
      {
        coordinator: app,
        picker: async () => {
          assert.fail('no context choice');
        },
        toChat: () => {},
      },
      'm',
      undefined,
      () => true,
    );

    assert.deepEqual(calls, [
      ['selectModel', { agent: 'a', id: 'm', effort: undefined }],
    ]);
  });

test('a direct model command keeps noninteractive selection with context metadata', async () => {
  const { app, calls } = fake({
    models: [
      {
        agent: 'a',
        id: 'm',
        label: 'Model M',
        efforts: [],
        contextWindows: { default: 258400, maximum: 828400 },
      },
    ],
  });

  await chooseModel(
    {
      coordinator: app,
      picker: async () => {
        assert.fail('noninteractive');
      },
      toChat: () => {},
    },
    'm',
  );

  assert.deepEqual(calls, [
    ['selectModel', { agent: 'a', id: 'm', effort: undefined }],
  ]);
});

test('a refused Codex window choice stops the remaining command batch', async () => {
  const { app, calls, coordinator } = fake({
    models: [
      {
        agent: 'a',
        id: 'm',
        label: 'Model M',
        efforts: [],
        contextWindows: { default: 258400, maximum: 828400 },
      },
    ],
  });

  coordinator.selectModel = async (...args: unknown[]) => {
    calls.push(['selectModel', ...args]);

    throw new Error('Window reload refused');
  };

  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));

  try {
    await openModels(ui, '/model /clear');

    ui.stdin.write(ENTER);

    await until('window picker', () =>
      ui.text().includes('Context window for m'),
    );

    ui.stdin.write(ENTER);

    await until('reported window refusal', () =>
      calls.some(([name]) => name === 'report'),
    );

    await until('batch released', () => !coordinator.snapshot.commandsPending);

    assert.equal(
      calls.some(([name]) => name === 'clear'),
      false,
    );

    assert.deepEqual(
      calls.find(([name]) => name === 'selectModel'),
      [
        'selectModel',
        { agent: 'a', id: 'm', effort: undefined, contextWindow: 'default' },
      ],
    );
  } finally {
    ui.unmount();
  }
});
