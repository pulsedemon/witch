import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from '../src/agents/types.js';
import { fixture, frameWriter, jsonLines } from './fixtures/claude-adapter.js';
import { until, within } from './fixtures/within.js';
import {
  background,
  lifecycle,
  result,
  state,
} from './fixtures/claude-background.js';

/** a native frame, a steered prompt that starts and fails, an interrupt or a killed CLI. */
type Step = object | 'steer' | 'interrupt' | 'kill' | 'close';

const week = { rateLimitType: 'seven_day', resetsAt: Date.now() / 1000 + 3600 };

const limit = (info: object = {}) => ({
  type: 'rate_limit_event',
  rate_limit_info: { status: 'rejected', ...week, ...info },
});

const failed = { type: 'result', is_error: true, result: 'API Error: 429' };

const idle = {
  type: 'system',
  subtype: 'session_state_changed',
  state: 'idle',
};

const failure = [failed, idle];

/** the last scripted turn's `exhausted` on a sonnet session, once that turn failed or was interrupted. */
async function exhausted(...turns: Step[][]) {
  const events: AgentEvent[] = [];

  const f = await fixture((event) => events.push(event), 'background');

  const reported = (name: string) =>
    events.some((e) => e.type === 'skills' && e.skills[0]?.name === name);

  const emit = frameWriter(f.cwd, reported, f.child);

  try {
    await f.session.selectModel('claude-sonnet-4-5');

    let result;

    for (const [index, steps] of turns.entries()) {
      const turn = f.session.send('limited');

      let uuid = '';

      await until('turn input', async () => {
        const inputs = await jsonLines(join(f.cwd, 'inputs.jsonl'));

        uuid = (inputs[index] as SDKUserMessage | undefined)?.uuid ?? '';

        return !!uuid;
      });

      if (!index) await until('initial reply', () => reported('result-1'));

      for (const step of steps)
        if (step === 'kill') f.child.kill();
        else if (step === 'close') void f.session.close();
        else if (step === 'interrupt') await f.session.interrupt();
        else if (step !== 'steer')
          await emit(
            'type' in step &&
              step.type === 'result' &&
              !('user_message_uuids' in step)
              ? { ...step, user_message_uuids: [uuid] }
              : step,
          );
        else {
          assert.equal(await f.session.steer('also'), true);

          let id = '';

          await until('steered input', async () => {
            const [, input] = await jsonLines(join(f.cwd, 'inputs.jsonl'));

            id = (input as SDKUserMessage | undefined)?.uuid ?? '';

            return !!id;
          });

          await emit(
            { type: 'command_lifecycle', command_uuid: id, state: 'started' },
            { ...failed, user_message_uuids: [id] },
          );
        }

      result = await turn;
    }

    const interrupted = turns.at(-1)!.includes('interrupt');

    assert.equal(result!.status, interrupted ? 'interrupted' : 'failed');

    return result!.exhausted;
  } finally {
    await f.session.close();
  }
}

test('Claude confirms exhaustion from a current rejection behind a failed result or exit', async () => {
  const cases: Step[][][] = [
    [[limit(), ...failure]],
    [[limit(), ...failure], failure], // a rejection in an earlier turn
    [[limit({ resetsAt: undefined }), ...failure]],
    [[limit({ rateLimitType: undefined }), 'steer', idle]],
    [[limit({ rateLimitType: 'seven_day_sonnet' }), ...failure]],
    [[limit(), 'kill']],
  ];

  for (const turns of cases)
    assert.equal(await exhausted(...turns), true, JSON.stringify(turns));
});

test('Claude leaves exhaustion unset without a current rejection behind a failed result or exit', async () => {
  const cases: Step[][][] = [
    [failure], // a plain 429
    [[limit(), ...failure], [{ type: 'result' }, idle], failure],
    [[limit({ resetsAt: Date.now() / 1000 - 60 }), ...failure]],
    [[limit({ overageInUse: true }), ...failure]],
    [[limit({ rateLimitType: 'seven_day_opus' }), ...failure]],
    [[limit(), 'interrupt']],
    [['kill']],
    [[limit(), 'close']],
  ];

  for (const turns of cases)
    assert.equal(await exhausted(...turns), undefined, JSON.stringify(turns));
});

test('a native background rejection reports exhaustion once after the ordinary turn completed', async () => {
  const f = await background();

  try {
    await f.emit(state('idle'));

    assert.equal((await f.turn).status, 'completed');

    await f.emit(
      state('running'),
      limit({ resetsAt: undefined, rateLimitType: undefined }),
      { ...failed, user_message_uuids: [] },
      idle,
    );

    await f.emit({ ...failed, user_message_uuids: [] });

    assert.equal(
      f.events.filter((event) => event.type === 'exhausted').length,
      1,
    );

    assert.equal(f.completions(), 1);
  } finally {
    await f.session.close();
  }
});

for (const [name, frames] of [
  ['plain throttling', [failed]],
  ['expired rejection', [limit({ resetsAt: 1 }), failed]],
  ['other model family', [limit({ rateLimitType: 'seven_day_opus' }), failed]],
  ['overage coverage', [limit({ isUsingOverage: true }), failed]],
  ['success after rejection', [limit(), result('Recovered.'), failed]],
] as const)
  test(`native background ${name} does not report exhaustion`, async () => {
    const f = await background();

    try {
      await f.emit(idle);

      await f.turn;

      await f.emit(state('running'), ...frames, idle);

      assert.equal(
        f.events.some((event) => event.type === 'exhausted'),
        false,
      );
    } finally {
      await f.session.close();
    }
  });

for (const stop of ['interrupt', 'exit'] as const)
  test(`a background rejection followed by ${stop} ${stop === 'exit' ? 'confirms' : 'does not confirm'} exhaustion`, async () => {
    const f = await background();

    try {
      await f.emit(idle);

      await f.turn;

      await f.emit(state('running'), limit());

      if (stop === 'interrupt') {
        await f.session.interrupt();

        await f.emit(failed, idle);
      } else {
        f.child.kill();

        await until('native closure', () =>
          f.events.some((event) => event.type === 'closed'),
        );
      }

      assert.equal(
        f.events.filter((event) => event.type === 'exhausted').length,
        stop === 'exit' ? 1 : 0,
      );
    } finally {
      await f.session.close();
    }
  });

test('background exhaustion recovers receipt-proven waiting input without treating it as Escape', async () => {
  const f = await background();

  try {
    await f.emit(idle);

    await f.turn;

    await f.emit(state('running'));

    const next = f.session.send('waiting request');

    await until(
      'waiting request sent',
      async () => (await f.inputs()).length === 2,
    );

    await f.steer('waiting follow-up');

    await f.emit(limit(), { ...failed, user_message_uuids: [] });

    const outcome = await within(next, 3000, 'waiting input recovery');

    assert.equal(outcome.status, 'failed');

    assert.equal(outcome.exhausted, true);

    assert.equal(outcome.inputUnread, true);

    assert.deepEqual(outcome.unread, ['waiting follow-up']);

    assert.equal(f.session.closed, true);

    assert.equal(
      f.events.filter((event) => event.type === 'exhausted').length,
      1,
    );
  } finally {
    await f.session.close();
  }
});

test('background exhaustion preserves a correlated reply that consumed the waiting input', async () => {
  const f = await background();

  try {
    await f.emit(idle);

    await f.turn;

    await f.emit(state('running'));

    const next = f.session.send('consumed request');

    await until('next input sent', async () => (await f.inputs()).length === 2);

    const uuid = (await f.inputs())[1]!.uuid!;

    await f.emit(
      limit(),
      { ...failed, user_message_uuids: [] },
      lifecycle(uuid, 'started'),
      result('Already handled.', [uuid]),
    );

    const outcome = await within(next, 3000, 'consumed input');

    assert.equal(outcome.status, 'completed');

    assert.equal(outcome.text, 'Already handled.');

    assert.equal(outcome.inputUnread, undefined);

    assert.deepEqual(outcome.unread, []);
  } finally {
    await f.session.close();
  }
});

test('unverified waiting input stays failed without a speculative replay', async () => {
  const f = await background();

  try {
    await f.emit(idle);

    await f.turn;

    await f.emit(state('running'));

    const next = f.session.send('uncertain request');

    await until('next input sent', async () => (await f.inputs()).length === 2);

    await writeFile(join(f.cwd, 'receipt.json'), '[]');

    await f.emit(limit(), { ...failed, user_message_uuids: [] });

    const outcome = await within(next, 3000, 'unverified input');

    assert.equal(outcome.status, 'failed');

    assert.match(outcome.error!, /consumption could not be verified/);

    assert.equal(outcome.inputUnread, undefined);

    assert.equal(outcome.exhausted, undefined);
  } finally {
    await f.session.close();
  }
});

test('background work from an automatic review does not switch the parent runtime', async () => {
  const f = await background();

  try {
    await f.emit(idle);

    await f.turn;

    const automatic = f.session.send('review', { purpose: 'pr-review' });

    await until('review input', async () => (await f.inputs()).length === 2);

    const uuid = (await f.inputs())[1]!.uuid!;

    await f.emit(lifecycle(uuid, 'started'), result('Reviewed.', [uuid]), idle);

    await automatic;

    await f.emit(state('running'), limit(), failed, idle);

    assert.equal(
      f.events.some((event) => event.type === 'exhausted'),
      false,
    );
  } finally {
    await f.session.close();
  }
});

test('a fresh connection cannot switch from an unsolicited background rejection', async () => {
  const events: AgentEvent[] = [];

  const f = await fixture((event) => events.push(event), 'background');

  const emit = frameWriter(
    f.cwd,
    (name) =>
      events.some(
        (event) => event.type === 'skills' && event.skills[0]?.name === name,
      ),
    f.child,
  );

  try {
    await emit(state('running'), limit(), failed, idle);

    assert.equal(
      events.some((event) => event.type === 'exhausted'),
      false,
    );
  } finally {
    await f.session.close();
  }
});

test('background recovery preserves an earlier correlated failure', async () => {
  const f = await background();

  try {
    await f.emit(idle);

    await f.turn;

    await f.emit(state('running'));

    const next = f.session.send('waiting initial');

    await until('waiting input', async () => (await f.inputs()).length === 2);

    const initial = (await f.inputs())[1]!.uuid!;

    const follow = await f.steer('later follow-up');

    await writeFile(join(f.cwd, 'receipt.json'), '[]');

    await f.emit(
      limit(),
      { ...failed, user_message_uuids: [] },
      lifecycle(initial, 'started'),
      {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        errors: ['Provider rejected initial input.'],
        user_message_uuids: [initial],
      },
      lifecycle(follow, 'started'),
      result('Follow-up handled.', [follow]),
    );

    const outcome = await within(next, 3000, 'recovery result');

    assert.equal(outcome.status, 'failed');

    assert.equal(outcome.error, 'Provider rejected initial input.');

    assert.equal(outcome.text, 'Follow-up handled.');
  } finally {
    await f.session.close();
  }
});
