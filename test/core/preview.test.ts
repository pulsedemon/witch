import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { Preview, previewDocumentSchema } from '../../src/core/preview.js';

const document = { title: 'Current preview', frames: [['first'], ['second']] };

test('preview replacement is atomic and stale closes or placements leave it intact', () => {
  const owner = new Preview();
  const seen: string[] = [];

  const unsubscribe = owner.subscribe(() =>
    seen.push(owner.snapshot?.status.title ?? 'closed'),
  );

  const first = owner.show(document);
  owner.placed(first.id, { columns: 80, rows: 2 });
  const placed = owner.snapshot;
  owner.placed(first.id, { columns: 80, rows: 2 });
  assert.equal(owner.snapshot, placed);
  owner.placed(first.id, { columns: 80, rows: 2, request: 'question' });
  assert.equal(owner.snapshot?.status.placement?.request, 'question');
  const second = owner.show({ title: 'Replacement', frames: [['new']] });
  assert.notEqual(first.id, second.id);
  assert.equal(owner.snapshot?.status.placement, undefined);
  assert.equal(owner.close(first.id), false);
  owner.placed(first.id, { columns: 5, rows: 9, request: 'old' });
  assert.equal(owner.snapshot?.status.id, second.id);
  assert.equal(owner.snapshot?.status.placement, undefined);
  assert.deepEqual(owner.snapshot?.document.frames, [['new']]);
  assert.equal(owner.close(second.id), true);
  assert.equal(owner.snapshot, undefined);

  assert.deepEqual(seen, [
    'Current preview',
    'Current preview',
    'Current preview',
    'Replacement',
    'closed',
  ]);

  unsubscribe();
});

test('accepted frame data is independent of its caller and cannot change after publication', () => {
  const owner = new Preview();
  const input = { title: 'Original', frames: [['original']] };
  owner.show(input);
  input.frames[0]![0] = 'mutated';
  assert.deepEqual(owner.snapshot?.document.frames, [['original']]);
  assert.ok(Object.isFrozen(owner.snapshot));
  assert.ok(Object.isFrozen(owner.snapshot?.document.frames[0]));
  owner.clear();
  assert.equal(owner.snapshot, undefined);
});

test('preview rows accept graphemes and only the documented SGR formatting', () => {
  for (const code of [
    '0',
    '',
    '1',
    '2',
    '22',
    '39',
    '49',
    '38;2;0;128;255',
    '48;2;255;0;8',
    '1;38;2;7;8;9;22',
    '1;38;2;000;010;255;48;2;1;2;3;22;39;49',
    ';1;;22;',
  ]) {
    assert.ok(
      previewDocumentSchema.safeParse({
        title: 'Style',
        frames: [[`${String.fromCharCode(27)}[${code}m(・∀・)🙂é`]],
      }).success,
      code,
    );
  }

  for (const text of [
    '\n',
    '\r',
    '\t',
    '\x00',
    '\x7f',
    '\x9b[31m',
    '\x9b[1;2mtext',
    '\x9b[38;2;1;2;3mtext',
    '\x1b[2J',
    '\x1b[6n',
    '\x1b]2;title\x07',
    '\x1b]8;;https://example.com\x07link',
    '\x1b[31m',
    '\x1b[4m',
    '\x1b[38;5;8m',
    '\x1b[38;2;256;0;0m',
    '\x1b[38;2;1;2m',
    '\x1b[38;2;0;;255m',
    '\x1b[38;2;0;1;2;31m',
    '\x1b[1;31;2m',
    '\x1b[',
  ]) {
    assert.equal(
      previewDocumentSchema.safeParse({ title: 'Rejected', frames: [[text]] })
        .success,
      false,
      JSON.stringify(text),
    );
  }

  assert.equal(
    previewDocumentSchema.safeParse({ title: '\x1b[0mTitle', frames: [['x']] })
      .success,
    false,
  );
});

test('short Unicode and styled rows validate without grapheme scans', () => {
  const segment = vi.spyOn(Intl.Segmenter.prototype, 'segment');

  const frames = [
    ['(・∀・)🙂é', '\x1b[1;38;2;000;010;255;22m(・∀・)🙂é'],
    ['界'.repeat(256)],
    ['\x1b[38;2;120;80;200m界'.repeat(256)],
  ];

  const document = previewDocumentSchema.parse({ title: 'Fast', frames });
  assert.deepEqual(document.frames, frames);
  assert.equal(segment.mock.calls.length, 0);
});

test('preview limits bound bytes, frames, rows and terminal columns', () => {
  for (const frames of [
    [],
    [[]],
    Array.from({ length: 241 }, () => ['x']),
    [Array.from({ length: 129 }, () => 'x')],
    [['🙂'.repeat(257)]],
    [['界'.repeat(257)]],
    [['x'.repeat(513)]],
  ])
    assert.equal(
      previewDocumentSchema.safeParse({ title: 'Too large', frames }).success,
      false,
    );

  assert.ok(
    previewDocumentSchema.safeParse({
      title: 'Edge',
      frames: [['🙂'.repeat(256)]],
    }).success,
  );

  assert.ok(
    previewDocumentSchema.safeParse({
      title: 'ASCII edge',
      frames: [['x'.repeat(512)]],
    }).success,
  );

  const frames = Array.from({ length: 240 }, () =>
    Array.from({ length: 128 }, () => 'x'.repeat(100)),
  );

  assert.equal(
    previewDocumentSchema.safeParse({ title: 'Too many bytes', frames })
      .success,
    false,
  );
});
