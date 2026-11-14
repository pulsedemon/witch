import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { autoReply, record, setup } from './fixtures/copilot-reviews.js';
import { until } from './fixtures/within.js';

for (const exit of [
  'a closed session',
  'a failed compaction',
  'an error',
  'an Escape',
  'an Escape as its row shows',
] as const)
  test(`${exit} before native input leaves feedback pending for a later attempt`, async (t) => {
    const x = await setup(t);
    const session = x.a.a.sessions.at(-1)!.session;
    const connect = x.a.a.connect.bind(x.a.a);

    vi.spyOn(x.a.a, 'connect').mockImplementation(async (options) => {
      const connected = await connect(options);

      autoReply(x.f, x.a, x.source);

      return connected;
    });

    autoReply(x.f, x.a, x.source);

    let staged = false;

    vi.spyOn(session, 'contextUsage').mockImplementationOnce(async () => {
      staged = true;

      if (exit === 'a closed session') await session.close();

      if (exit === 'an error') throw new Error('Context usage unavailable');

      if (exit === 'an Escape') await x.c.interrupt();

      if (exit === 'an Escape as its row shows') {
        const stop = x.c.subscribe(() => {
          if (
            x.c.snapshot.items.some(({ text }) => text.startsWith('Handling'))
          ) {
            stop();

            void x.c.interrupt();
          }
        });
      }

      if (exit === 'a failed compaction') {
        x.a.a.failNext = true;

        return 85;
      }

      return undefined;
    });

    await x.observe();

    await until('unsent review settlement', async () => {
      const state = (await record(x.f, x.a)).copilotReviews![0]!;

      return (
        staged &&
        !x.c.snapshot.reviewing &&
        !state.batch &&
        state.items.every(({ status }) => status === 'pending')
      );
    });

    assert.equal(x.reviews().length, 0);

    assert.ok(
      !x.c.snapshot.items.some(({ text }) =>
        text.includes('outcome is uncertain'),
      ),
    );

    if (exit === 'a closed session') await x.observe();
    else await x.c.send('continue');

    await x.handled();

    assert.equal(x.reviews().length, 1);
  });

test('a summary with no open issues is handled without a review turn', async (t) => {
  const x = await setup(t);
  x.source.threads = [];

  x.source.reviews[0]!.body =
    '### 🟢 Approval recommended\n\n**No open issues** 🎉';

  await x.observe();

  await x.handled();

  const state = (await record(x.f, x.a)).copilotReviews![0]!;

  assert.equal(state.batch, undefined);

  assert.equal(state.items[0]!.receipts[0]!.disposition, 'covered');

  assert.equal(x.reviews().length, 0);

  assert.equal(x.a.a.inputs.length, 0);
});
