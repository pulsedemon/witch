import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Ajv } from 'ajv';
import { test } from 'vitest';
import {
  parsePeerAnswers,
  peerAnswerOutputSchema,
  preparePeerAnswers,
} from '../src/core/peer-answers.js';
import type { PeerRequest } from '../src/core/peer-requests.js';
import { requestContext } from '../src/core/peer-requests.js';
import { scratch } from './fixtures/scratch.js';

const first: PeerRequest = {
  id: randomUUID(),
  project: 'project',
  from: 'asker',
  to: 'owner',
  claim: randomUUID(),
  reference: 'task:first',
  message: 'first private text',
  askedAt: '2026-10-30T00:00:00Z',
};

const second = { ...first, id: randomUUID(), message: 'second private text' };
const requests = [first, second];

test('the request file carries the messages and native context carries its path and metadata', async () => {
  const batch = await preparePeerAnswers(
    requests,
    await scratch('peer-input-'),
  );

  assert.deepEqual(JSON.parse(await readFile(batch.file, 'utf8')), requests);

  const context = requestContext(batch);

  assert.ok(context.includes(JSON.stringify(batch.file)));

  for (const request of requests) {
    assert.ok(context.includes(request.id));

    assert.ok(!context.includes(request.message));
  }
});

test('the native Draft 7 validator accepts the generated response contract', () => {
  const ajv = new Ajv({ strict: false, validateFormats: false });
  const validate = ajv.compile(peerAnswerOutputSchema);
  const answer = { answers: [{ id: first.id, message: 'one' }] };

  assert.equal(validate(answer), true, JSON.stringify(validate.errors));

  assert.equal(validate({ answers: [{ id: first.id }] }), false);

  assert.equal(validate({ answers: [], unrelated: 'extra' }), false);
});

test('answers keep their request ids even when the native reply reverses their order', () => {
  const answers = [
    { id: second.id, message: 'answer two' },
    { id: first.id, message: 'answer one' },
  ];

  assert.deepEqual(
    parsePeerAnswers(JSON.stringify({ answers }), requests),
    answers,
  );
});

test('an invalid batch cannot produce a publishable prefix', () => {
  for (const answers of [
    [{ id: first.id, message: 'one' }],
    [
      { id: first.id, message: 'one' },
      { id: first.id, message: 'duplicate' },
    ],
    [
      { id: first.id, message: 'one' },
      { id: randomUUID(), message: 'foreign' },
    ],
    [
      { id: first.id, message: 'one' },
      { id: second.id, message: '   ' },
    ],
  ])
    assert.throws(() =>
      parsePeerAnswers(JSON.stringify({ answers }), requests),
    );

  assert.throws(() => parsePeerAnswers('explanation {"answers":[]}', requests));
});
