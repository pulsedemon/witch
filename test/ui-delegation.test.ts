import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createElement } from 'react';
import { test } from 'vitest';
import { defaultPolicy } from '../src/core/routing.js';
import type { Catalog } from '../src/core/routing.js';
import { DelegationStore } from '../src/persistence/delegation.js';
import { App } from '../src/ui/app.js';
import { changeDelegation, delegationPage } from '../src/ui/delegation.js';
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
    ['review both', { ...policy, work: { review: 'both' } }],
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

test('the policy page shows the rule each kind of work follows when it has none', () => {
  const page = delegationPage(defaultPolicy, catalog, {}, installed, 0);
  assert.match(page, /^review +both$/m);
  assert.match(page, /^implementation +same$/m);
});

test('/delegation refuses a default or versioned family, an unknown kind or runtime, an empty runtime or model and a level out of range', () => {
  for (const [argument, refusal] of [
    ['family claude default', 'name a claude family or model, not default.'],
    ['family codex gpt-6-sol', 'gpt-6-sol names a model, not a family.'],
    ['family codex nova', 'codex lists no nova model to run.'],
    ['family claude constructor', 'claude lists no constructor model to run.'],
    ['triage other', /^Use \/delegation/],
    ['review gemini', 'gemini is not installed.'],
    ['review claude:', /^Use \/delegation/],
    ['review :gpt-6-sol', /^Use \/delegation/],
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

test('a refused /delegation change cancels the commands after it', async () => {
  const { app, calls } = fake({
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
    ui.stdin.write(`/delegation shift 0 /clear${ENTER}`);
    await until('the canceled batch', () =>
      calls.some(
        ([name, text]) =>
          name === 'notice' &&
          text ===
            'Commands canceled. Retry explicitly: /delegation shift 0; /clear',
      ),
    );
    assert.ok(
      calls.some(
        ([name, text]) =>
          name === 'notice' &&
          text === 'Use a whole percent from 1 to 100, or off.',
      ),
    );
    assert.ok(!calls.some(([name]) => name === 'clear'));
    assert.deepEqual(await policy.read(), defaultPolicy);
  } finally {
    ui.unmount();
  }
});

test('an unreadable policy file is named in the error rather than replaced', async () => {
  const directory = `${await scratch('witch-delegation-')}/delegation`;
  const store = await DelegationStore.open(directory);
  await writeFile(`${directory}/policy.json`, '{"shiftAt": 90,');
  await assert.rejects(store.read(), {
    message: new RegExp(
      `^The delegation policy at ${directory}/policy\\.json is unreadable; fix or delete it\\. `,
    ),
  });
});
