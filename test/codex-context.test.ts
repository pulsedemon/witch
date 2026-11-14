import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { close, fixture } from './fixtures/codex-adapter.js';
import { appears, within } from './fixtures/within.js';

async function inserted(cwd: string) {
  await appears(join(cwd, 'context.json'), 'native context insertion');
}

test('Codex inserts complete context before the exact user request', async () => {
  const { session, cwd } = await fixture(
    (event) => {
      if (event.type === 'request')
        session.respond(event.request.id, { decision: 'accept' });
    },
    { mode: 'context-held' },
  );

  try {
    const prompt = '  review target 17\nonly the selected files  ';

    const context = `context 29\n${'é'.repeat(5000)}\ncontext 41`;

    await writeFile(join(cwd, 'release'), 'yes');

    const sending = session.send(prompt, { context });

    await inserted(cwd);

    await assert.rejects(access(join(cwd, 'prompt.json')));

    await writeFile(join(cwd, 'release-context'), 'yes');

    assert.deepEqual(await within(sending, 5000, 'contextual turn'), {
      status: 'completed',
      text: 'Finished.',
    });

    const injection = JSON.parse(
      await readFile(join(cwd, 'context.json'), 'utf8'),
    );

    assert.deepEqual(injection, {
      threadId: 'native-thread',
      items: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: context }],
        },
      ],
    });

    const start = JSON.parse(await readFile(join(cwd, 'prompt.json'), 'utf8'));

    assert.deepEqual(start.params.input, [
      { type: 'text', text: prompt, text_elements: [] },
    ]);

    assert.equal(await readFile(join(cwd, 'approved.txt'), 'utf8'), 'approved');
  } finally {
    await writeFile(join(cwd, 'release-context'), 'yes');

    await close(session, cwd);
  }
});

for (const mode of ['context-error', 'context-exit']) {
  test(`Codex reports unwritten input when insertion fails (${mode})`, async () => {
    const { session, cwd } = await fixture(undefined, { mode });

    try {
      const result = await within(
        session.send('request 17', { context: 'context 29' }),
        5000,
        'failed context insertion',
      );

      assert.equal(result.status, 'failed');

      assert.equal(result.inputUnsent, true);

      await assert.rejects(access(join(cwd, 'prompt.json')));
    } finally {
      await close(session, cwd);
    }
  });
}

for (const action of ['interrupt', 'close'] as const) {
  test(`Codex ${action} during insertion never submits a turn`, async () => {
    const { session, cwd } = await fixture(undefined, { mode: 'context-held' });

    try {
      const sending = session.send('request 17', { context: 'context 29' });

      await inserted(cwd);

      const stopping = session[action]();

      await writeFile(join(cwd, 'release-context'), 'yes');

      assert.deepEqual(await within(sending, 5000, 'canceled input'), {
        status: 'interrupted',
        text: '',
        inputUnsent: true,
      });

      await within(stopping, 5000, 'completed cancellation');

      await assert.rejects(access(join(cwd, 'prompt.json')));
    } finally {
      await writeFile(join(cwd, 'release-context'), 'yes');

      await close(session, cwd);
    }
  });
}

test('a failed turn-start response does not prove the input was unwritten', async () => {
  const { session, cwd } = await fixture(undefined, {
    mode: 'context-start-error',
  });

  try {
    const result = await session.send('request 17', { context: 'context 29' });

    assert.equal(result.status, 'failed');

    assert.equal(result.inputUnsent, undefined);

    const start = JSON.parse(await readFile(join(cwd, 'prompt.json'), 'utf8'));

    assert.equal(start.params.input[0].text, 'request 17');
  } finally {
    await close(session, cwd);
  }
});
