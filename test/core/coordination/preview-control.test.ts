import assert from 'node:assert/strict';
import { test } from 'vitest';
import { callControl } from '../../../src/persistence/control.js';
import { orderedCleanup } from '../../fixtures/cleanup.js';
import { unitCoordinationFixture } from '../../fixtures/coordination.js';

const document = { title: 'Current preview', frames: [['first'], ['second']] };

test('bound previews survive a turn, reject stale authority and clear on /clear, conversation switch and exit', async (t) => {
  const { start } = await unitCoordinationFixture(
    orderedCleanup(t.onTestFinished),
  );

  const a = await start('A');
  const b = await start('B');
  const binding = await a.binding();
  const shown = await callControl(binding, { kind: 'preview', document });
  assert.equal(shown.kind, 'preview');

  if (shown.kind !== 'preview') return;

  const id = shown.preview!.id;
  assert.deepEqual(a.coordination.preview.snapshot?.document, document);
  assert.equal(b.coordination.preview.snapshot, undefined);

  a.coordination.preview.placed(id, {
    columns: 80,
    rows: 2,
    request: 'question',
  });

  const placed = await callControl(binding, { kind: 'preview-status' });
  assert.equal(placed.kind, 'preview');

  if (placed.kind !== 'preview') return;

  assert.deepEqual(placed.preview?.placement, {
    columns: 80,
    rows: 2,
    request: 'question',
  });

  await a.coordinator.send('Hello');
  assert.equal(a.coordination.preview.snapshot?.status.id, id);

  const replacement = await callControl(binding, {
    kind: 'preview',
    document: { title: 'New', frames: [['latest']] },
  });

  assert.equal(replacement.kind, 'preview');

  if (replacement.kind !== 'preview') return;

  const stale = await callControl(binding, {
    kind: 'preview-close',
    preview: id,
  });

  assert.equal(stale.kind, 'preview');

  if (stale.kind !== 'preview') return;

  assert.equal(stale.closed, false);
  assert.equal(stale.preview?.id, replacement.preview?.id);

  const wrong = await callControl(
    { ...binding, activation: '11111111-1111-4111-8111-111111111111' },
    { kind: 'preview-status' },
  );

  assert.equal(wrong.kind, 'error');
  await a.coordinator.clear();
  assert.equal(a.coordination.preview.snapshot, undefined);

  assert.equal(
    (await callControl(binding, { kind: 'preview', document })).kind,
    'error',
  );

  await callControl(await a.binding(), { kind: 'preview', document });
  await a.coordinator.newConversation();
  assert.equal(a.coordination.preview.snapshot, undefined);
  await callControl(await a.binding(), { kind: 'preview', document });
  await a.coordinator.close();
  assert.equal(a.coordination.preview.snapshot, undefined);
});

test('automatic peer answers can inspect a preview but cannot replace or close it', async (t) => {
  const { start } = await unitCoordinationFixture(
    orderedCleanup(t.onTestFinished),
  );

  const a = await start();
  const binding = await a.binding();
  const shown = await callControl(binding, { kind: 'preview', document });
  assert.equal(shown.kind, 'preview');

  if (shown.kind !== 'preview') return;

  a.coordination.update({ ...a.coordinator.snapshot, answering: true });

  for (const action of [
    { kind: 'preview' as const, document },
    { kind: 'preview-close' as const, preview: shown.preview!.id },
  ])
    assert.equal((await callControl(binding, action)).kind, 'error');

  const status = await callControl(binding, { kind: 'preview-status' });
  assert.equal(status.kind, 'preview');

  if (status.kind !== 'preview') return;

  assert.equal(status.preview?.id, shown.preview?.id);
});
