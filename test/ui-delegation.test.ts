import assert from 'node:assert/strict';
import { createElement } from 'react';
import { test } from 'vitest';
import { defaultPolicy } from '../src/core/routing.js';
import type { Catalog } from '../src/core/routing.js';
import { DelegationStore } from '../src/persistence/delegation.js';
import { App } from '../src/ui/app.js';
import { changeDelegation } from '../src/ui/delegation.js';
import { scratch } from './fixtures/scratch.js';
import { ENTER, fake, show } from './fixtures/ui.js';
import { until } from './fixtures/within.js';

const catalog: Catalog = {
  models: ['gpt-6.1-sol', 'gpt-6-astra'].map((id) => ({
    agent: 'codex',
    id,
    label: id,
    efforts: [],
  })),
  latest: { claude: { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5' } },
};
const installed = ['claude', 'codex'];

test('each /delegation change round-trips through the policy file', async () => {
  const store = await DelegationStore.open(
    `${await scratch('witch-delegation-')}/delegation`,
  );
  assert.deepEqual(await store.read(), defaultPolicy);
  let policy = defaultPolicy;
  for (const [argument, expected] of [
    ['review other', { ...policy, work: { review: 'other' } }],
    [
      'implementation codex:astra',
      { ...policy, work: { review: 'other', implementation: 'codex:astra' } },
    ],
    ['review clear', { ...policy, work: { implementation: 'codex:astra' } }],
    [
      'family claude sonnet',
      {
        ...policy,
        families: { claude: 'sonnet', codex: 'sol' },
        work: { implementation: 'codex:astra' },
      },
    ],
    [
      'shift 75',
      {
        shiftAt: 75,
        families: { claude: 'sonnet', codex: 'sol' },
        work: { implementation: 'codex:astra' },
      },
    ],
    [
      'shift off',
      {
        shiftAt: null,
        families: { claude: 'sonnet', codex: 'sol' },
        work: { implementation: 'codex:astra' },
      },
    ],
  ] as const) {
    const changed = changeDelegation(argument, policy, catalog, installed);
    assert.deepEqual(changed, expected, argument);
    await store.write(changed as typeof policy);
    policy = await store.read();
    assert.deepEqual(policy, expected, argument);
  }
});

test('/delegation refuses a default or versioned family, an unknown kind or runtime, and a level out of range', () => {
  for (const [argument, refusal] of [
    ['family claude default', 'name a claude family or model, not default.'],
    ['family codex gpt-6-sol', 'gpt-6-sol names a model, not a family.'],
    ['family codex nova', 'codex lists no nova model to run.'],
    ['triage other', /^Use \/delegation/],
    ['review gemini', 'gemini is not installed.'],
    ['review claude:haiku', 'claude lists no haiku model to run.'],
    ['shift 0', 'Use a whole percent from 1 to 100, or off.'],
    ['shift 101', 'Use a whole percent from 1 to 100, or off.'],
  ] as const) {
    const changed = changeDelegation(
      argument,
      defaultPolicy,
      catalog,
      installed,
    );
    assert.equal(typeof changed, 'string', argument);
    if (typeof refusal === 'string') assert.equal(changed, refusal);
    else assert.match(changed as string, refusal);
  }
});

test('/delegation shows the policy and saves a change before showing it again', async () => {
  const { app } = fake({
    agents: ['claude', 'codex'].map((id) => ({
      id,
      label: id,
      installed: true,
    })),
    models: catalog.models,
    latest: catalog.latest,
  });
  const policy = await DelegationStore.open(
    `${await scratch('witch-delegation-')}/delegation`,
  );
  const ui = show(
    createElement(App, { coordinator: app, policy, onExit: () => {} }),
  );
  try {
    ui.stdin.write(`/delegation review other${ENTER}`);
    await until('the policy page', () => ui.text().includes('Families'));
    assert.deepEqual(await policy.read(), {
      ...defaultPolicy,
      work: { review: 'other' },
    });
    assert.match(ui.text(), /review +other/);
    assert.match(ui.text(), /claude {2}opus → claude-opus-5-5/);
    assert.match(ui.text(), /codex {2}sol → gpt-6\.1-sol/);
  } finally {
    ui.unmount();
  }
});
