import assert from 'node:assert/strict';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { content, fixture, jsonLines } from '../../fixtures/claude-adapter.js';
import { until, within } from '../../fixtures/within.js';

const block = (media_type: string, data: string) => ({
  type: 'image',
  source: {
    type: 'base64',
    media_type,
    data: Buffer.from(data).toString('base64'),
  },
});

test("a prompt whose image can't be read starts no turn and keeps the command records, which then go ahead of the next prompt's text, images and spell", async () => {
  const { session, cwd } = await fixture();
  const [shot, photo] = [join(cwd, 'shot.png'), join(cwd, 'photo.jpg')];
  const missing = join(cwd, 'missing.png');
  const skill = { name: 'review', args: 'main' };

  try {
    await writeFile(shot, 'png bytes');
    await writeFile(photo, 'jpeg bytes');
    await session.shell('printf alpha');

    assert.deepEqual(
      await session.send('look', { skill, images: [shot, missing] }),
      {
        status: 'failed',
        text: '',
        error: `ENOENT: no such file or directory, open '${missing}'`,
        inputUnsent: true,
      },
    );

    await assert.rejects(access(join(cwd, 'content.json')));

    await within(
      session.send('look', { skill, images: [shot, photo] }),
      3000,
      'the turn',
    );

    assert.deepEqual(await content(cwd), [
      {
        type: 'text',
        text: '<bash-input>printf alpha</bash-input>\n<bash-stdout>alpha</bash-stdout><bash-stderr></bash-stderr>',
      },
      { type: 'text', text: 'look' },
      block('image/png', 'png bytes'),
      block('image/jpeg', 'jpeg bytes'),
      { type: 'text', text: '/review main' },
    ]);
  } finally {
    await session.close();
  }
});

test("a prompt or spell steered with an image goes as blocks, the spell named once after its image, a spell without one goes as typed, and one whose image can't be read is refused", async () => {
  const { session, cwd } = await fixture();
  const steered = join(cwd, 'steered.jsonl');
  const images = [join(cwd, 'shot.png')];

  try {
    await writeFile(images[0]!, 'png bytes');
    const turn = session.send('reporting familiar');
    await until('the reply', () => session.replied);

    assert.equal(
      await session.steer('gone', { images: [join(cwd, 'missing.png')] }),
      false,
    );

    assert.equal(await session.steer('look', { images }), true);

    assert.equal(
      await session.steer('/review now', {
        skill: { name: 'review', args: 'now' },
        images,
      }),
      true,
    );

    assert.equal(
      await session.steer('/review later', {
        skill: { name: 'review', args: 'later' },
      }),
      true,
    );

    const expected = [
      [{ type: 'text', text: 'look' }, block('image/png', 'png bytes')],
      [block('image/png', 'png bytes'), { type: 'text', text: '/review now' }],
      '/review later',
    ];

    await until(
      'the steered prompts',
      async () => (await jsonLines(steered)).length === expected.length,
    );

    assert.deepEqual(await jsonLines(steered), expected);

    for (const file of ['allow-report', 'allow-idle'])
      await writeFile(join(cwd, file), 'yes');

    assert.equal((await within(turn, 2000, 'turn')).status, 'completed');
  } finally {
    await session.close();
  }
});
