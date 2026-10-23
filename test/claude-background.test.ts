import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from '../src/agents/types.js';
import {
  fixture,
  frameWriter,
  jsonLines,
  launcher,
  working,
} from './fixtures/claude-adapter.js';
import { until, within } from './fixtures/within.js';

const state = (state: string) => ({
  type: 'system',
  subtype: 'session_state_changed',
  state,
});
const lifecycle = (uuid: string, state: string, session_id?: string) => ({
  type: 'command_lifecycle',
  command_uuid: uuid,
  state,
  ...(session_id ? { session_id } : {}),
});
const result = (text: string, uuids?: string[]) => ({
  type: 'result',
  result: text,
  ...(uuids ? { user_message_uuids: uuids } : {}),
});

async function background() {
  const events: AgentEvent[] = [];
  const f = await fixture((e) => events.push(e), 'background');
  const emit = frameWriter(
    f.cwd,
    (name) =>
      events.some((e) => e.type === 'skills' && e.skills[0]?.name === name),
    f.child,
  );
  let completions = 0;
  const turn = f.session.send('initial').then((outcome) => {
    completions++;
    return outcome;
  });
  await until('initial result', () => f.session.usage.cost === 0.25);
  const inputs = async () =>
    (await jsonLines(join(f.cwd, 'inputs.jsonl'))) as SDKUserMessage[];
  const steer = async (text: string) => {
    assert.equal(await f.session.steer(text), true);
    let uuid = '';
    await until('steered input', async () => {
      uuid =
        (await inputs()).find((input) => input.message.content === text)
          ?.uuid ?? '';
      return !!uuid;
    });
    return uuid;
  };
  return {
    ...f,
    events,
    emit,
    turn,
    steer,
    inputs,
    completions: () => completions,
  };
}

async function commandReply(f: Awaited<ReturnType<typeof background>>) {
  await f.emit({
    type: 'system',
    subtype: 'task_started',
    task_id: 'helper',
    task_type: 'local_agent',
    description: 'Helper',
    tool_use_id: 'helper-tool',
  });
  const command = "printf 'once\\n' >> executions; printf 'command-output\\n'";
  const prompt = `!${command}\n\nReply without running it again.`;
  const record = `<bash-input>${command}</bash-input>\n<bash-stdout>command-output\n</bash-stdout><bash-stderr></bash-stderr>`;
  assert.equal(await f.session.steer(prompt, { command }), true);
  let uuid = '';
  await until('command reply input', async () => {
    uuid = (await f.inputs())[1]?.uuid ?? '';
    return !!uuid;
  });
  assert.deepEqual((await f.inputs())[1]!.message.content, [
    { type: 'text', text: record },
    { type: 'text', text: prompt },
  ]);
  await f.emit(lifecycle(uuid, 'queued'), {
    type: 'system',
    subtype: 'task_notification',
    task_id: 'helper',
    status: 'completed',
    output_file: '',
    summary: 'Complete',
  });
  return { uuid, record };
}

await test('a steered command reply waits for consumption and a fresh result', async () => {
  const f = await background();
  try {
    const { uuid } = await commandReply(f);
    await f.emit(state('idle'));
    assert.equal(f.completions(), 0, 'idle must retain the command reply');
    await f.emit(state('running'), lifecycle(uuid, 'started'), state('idle'));
    assert.equal(f.completions(), 0, 'consumption must clear the old result');
    await f.emit(
      state('running'),
      result('Fresh command reply.'),
      state('idle'),
    );
    assert.deepEqual(await within(f.turn, 2000, 'command reply'), {
      status: 'completed',
      text: 'Fresh command reply.',
    });
    assert.equal(f.completions(), 1);
    assert.equal((await f.inputs()).length, 2);
    assert.equal(await readFile(join(f.cwd, 'executions'), 'utf8'), 'once\n');
  } finally {
    await f.session.close();
  }
});

for (const singular of [false, true]) {
  await test(`a correlated result consumes a steered command reply (${singular ? 'single UUID' : 'UUID list'})`, async () => {
    const f = await background();
    try {
      const { uuid } = await commandReply(f);
      await f.emit(result('Unrelated.', [randomUUID()]), state('idle'));
      assert.equal(f.completions(), 0);
      await f.emit(
        state('running'),
        {
          ...result('Correlated command reply.'),
          ...(singular
            ? { user_message_uuid: uuid }
            : { user_message_uuids: [uuid] }),
        },
        state('idle'),
      );
      assert.deepEqual(await within(f.turn, 2000, 'correlated command reply'), {
        status: 'completed',
        text: 'Correlated command reply.',
      });
    } finally {
      await f.session.close();
    }
  });
}

await test('a refused steered command reply fails the Witch turn', async () => {
  const f = await background();
  try {
    const { uuid } = await commandReply(f);
    await f.emit(lifecycle(uuid, 'refused'), state('idle'));
    const outcome = await within(f.turn, 2000, 'refused command reply');
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.error, 'Claude refused a steered prompt');
  } finally {
    await f.session.close();
  }
});

await test('an interrupted command reply recovers output without replaying the command', async () => {
  const f = await background();
  try {
    const { record } = await commandReply(f);
    await f.steer('ordinary follow-up');
    await within(f.session.interrupt(), 3000, 'interrupt');
    const outcome = await within(f.turn, 2000, 'interrupted command reply');
    assert.equal(outcome.status, 'interrupted');
    assert.deepEqual(outcome.unread, ['ordinary follow-up']);
    assert.deepEqual(outcome.unreadContext, [record]);
    assert.equal(f.session.closed, true);
    assert.equal(await readFile(join(f.cwd, 'executions'), 'utf8'), 'once\n');
  } finally {
    await f.session.close();
  }
});

for (const task of [undefined, 'mcp_task', 'remote_agent', 'monitor_mcp']) {
  await test(`a post-result prompt remains in the Witch turn across native idle (${task ?? 'no task frame'})`, async () => {
    const f = await background();
    try {
      if (task)
        await f.emit({
          type: 'system',
          subtype: 'background_tasks_changed',
          tasks: [
            {
              task_id: 'background',
              task_type: task,
              description: 'Background work',
            },
          ],
        });
      assert.equal(f.session.replied, false);
      const uuid = await f.steer('follow-up');
      await f.emit(state('idle'), lifecycle(uuid, 'queued'));
      assert.equal(
        f.completions(),
        0,
        'earlier idle must retain accepted input',
      );
      await f.emit(state('running'), lifecycle(uuid, 'started'), state('idle'));
      assert.equal(
        f.completions(),
        0,
        'consumption cannot reuse the preceding result',
      );
      await f.emit(
        state('running'),
        result('Follow-up answer.'),
        lifecycle(uuid, 'started'),
        state('idle'),
      );
      assert.deepEqual(await within(f.turn, 2000, 'follow-up idle'), {
        status: 'completed',
        text: 'Follow-up answer.',
      });
      assert.equal(f.completions(), 1);
      assert.deepEqual(
        (await f.inputs()).map((input) => input.message.content),
        ['initial', 'follow-up'],
      );
    } finally {
      await f.session.close();
    }
  });
}

await test('malformed lifecycle frames do not consume a pending prompt', async () => {
  const f = await background();
  try {
    const uuid = await f.steer('follow-up');
    await f.emit(lifecycle(uuid, 'invalid-state'), state('idle'));
    assert.equal(f.completions(), 0);
    assert.equal(f.session.closed, false);
    await f.emit(
      state('running'),
      lifecycle(uuid, 'started'),
      result('Accepted.', [uuid]),
      state('idle'),
    );
    assert.deepEqual(await within(f.turn, 2000, 'valid lifecycle'), {
      status: 'completed',
      text: 'Accepted.',
    });
    assert.deepEqual(
      (await f.inputs()).map((input) => input.message.content),
      ['initial', 'follow-up'],
    );
  } finally {
    await f.session.close();
  }
});

await test('each steered prompt needs its own main-session consumption evidence', async () => {
  const f = await background();
  try {
    const a = await f.steer('prompt A');
    const b = await f.steer('prompt B');
    await f.emit(
      result('Unrelated.', [randomUUID()]),
      lifecycle(a, 'queued'),
      lifecycle(a, 'started', randomUUID()),
      lifecycle(randomUUID(), 'refused'),
      lifecycle(b, 'started'),
      result('Answer B.', [b]),
      state('idle'),
    );
    assert.equal(f.completions(), 0, 'B cannot account for A');
    await f.emit(state('running'), lifecycle(a, 'started'), state('idle'));
    assert.equal(f.completions(), 0, "A cannot use B's preceding result");
    await f.emit(state('running'), result('Answer A.', [a]), state('idle'));
    assert.deepEqual(await within(f.turn, 2000, 'both inputs'), {
      status: 'completed',
      text: 'Answer A.',
    });
    assert.deepEqual(
      (await f.inputs()).map((input) => input.message.content),
      ['initial', 'prompt A', 'prompt B'],
    );
  } finally {
    await f.session.close();
  }
});

for (const singular of [false, true]) {
  await test(`a correlated result accounts for input without a started event (${singular ? 'single UUID' : 'UUID list'})`, async () => {
    const f = await background();
    try {
      const uuid = await f.steer('correlated');
      await f.emit(result('Unrelated.', [randomUUID()]), state('idle'));
      assert.equal(f.completions(), 0);
      await f.emit(
        state('running'),
        {
          ...result('Correlated answer.'),
          ...(singular
            ? { user_message_uuid: uuid }
            : { user_message_uuids: [uuid] }),
        },
        state('idle'),
      );
      assert.deepEqual(await within(f.turn, 2000, 'correlated result'), {
        status: 'completed',
        text: 'Correlated answer.',
      });
    } finally {
      await f.session.close();
    }
  });
}

for (const [laterReport, error] of [
  [false, 'Provider rejected follow-up.'],
  [true, 'Provider rejected follow-up.'],
  [true, ''],
] as const) {
  await test(`missing terminal events cannot hang a failed input${laterReport ? ' or let a later report erase its failure' : ''}${error ? '' : ' with empty error text'}`, async () => {
    const f = await background();
    try {
      const uuid = await f.steer('failing follow-up');
      await f.emit(lifecycle(uuid, 'started'), {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        errors: error ? [error] : [],
        ...(laterReport ? { user_message_uuids: [uuid] } : {}),
      });
      if (laterReport)
        await f.emit(result('Background success.', [randomUUID()]));
      await f.emit(state('idle'));
      const outcome = await within(f.turn, 2000, 'failed follow-up');
      assert.equal(outcome.status, 'failed');
      assert.equal(outcome.error, error);
    } finally {
      await f.session.close();
    }
  });
}

for (const disposition of ['refused', 'discarded', 'cancelled']) {
  await test(`input ${disposition} before consumption settles failed at native idle`, async () => {
    const f = await background();
    try {
      const uuid = await f.steer('rejected follow-up');
      await f.emit(state('idle'));
      assert.equal(f.completions(), 0);
      await f.emit(lifecycle(uuid, disposition));
      const outcome = await within(f.turn, 2000, 'input disposition');
      assert.equal(outcome.status, 'failed');
      assert.match(outcome.error!, new RegExp(disposition));
      assert.deepEqual(
        (await f.inputs()).map((input) => input.message.content),
        ['initial', 'rejected follow-up'],
      );
    } finally {
      await f.session.close();
    }
  });
}

await test('an interrupt after the idle gap recovers only native-unread prompts', async () => {
  const f = await background();
  try {
    const a = await f.steer('consumed A');
    const b = await f.steer('unread B');
    await f.emit(state('idle'));
    assert.equal(f.completions(), 0);
    await f.emit(
      state('running'),
      lifecycle(a, 'started'),
      result('Answer A.', [a]),
      lifecycle(b, 'queued'),
      state('idle'),
    );
    await within(f.session.interrupt(), 2000, 'idle-gap interrupt');
    const outcome = await f.turn;
    assert.equal(outcome.status, 'interrupted');
    assert.deepEqual(outcome.unread, ['unread B']);
    assert.equal(f.session.closed, true);
    assert.equal(await f.session.steer('no replay'), false);
    assert.deepEqual(
      (await f.inputs()).map((input) => input.message.content),
      ['initial', 'consumed A', 'unread B'],
    );
    await until('closure notification', () =>
      f.events.some((event) => event.type === 'closed'),
    );
  } finally {
    await f.session.close();
  }
  assert.equal(f.events.filter((event) => event.type === 'closed').length, 1);
});

await test('an interrupt after admission cannot overtake accepted input', async () => {
  const f = await background();
  try {
    const admission = f.session.steer(
      'accepted immediately before interruption',
    );
    const interruption = f.session.interrupt();
    assert.equal(await admission, true);
    await within(interruption, 2000, 'dispatch interrupt');
    const outcome = await f.turn;
    assert.equal(outcome.status, 'interrupted');
    assert.deepEqual(outcome.unread, [
      'accepted immediately before interruption',
    ]);
    assert.equal(f.session.closed, true);
    const wire = (await jsonLines(join(f.cwd, 'wire.jsonl'))) as {
      type: string;
      request?: { subtype: string };
      message?: { content: string };
    }[];
    const input = wire.findIndex(
      (frame) =>
        frame.message?.content === 'accepted immediately before interruption',
    );
    const interrupt = wire.findIndex(
      (frame) => frame.request?.subtype === 'interrupt',
    );
    assert.ok(
      input >= 0 && input < interrupt,
      'accepted input must precede the receipt snapshot',
    );
    assert.equal((await f.inputs()).length, 2);
  } finally {
    await f.session.close();
  }
});

await test('an interrupt receipt retains the text of already consumed input', async () => {
  const f = await background();
  try {
    const uuid = await f.steer('consumed but receipt-listed');
    await f.emit(lifecycle(uuid, 'started'));
    await writeFile(
      join(f.cwd, 'receipt.json'),
      JSON.stringify([randomUUID(), uuid]),
    );
    await within(f.session.interrupt(), 2000, 'consumed input receipt');
    const outcome = await f.turn;
    assert.equal(outcome.status, 'interrupted');
    assert.deepEqual(outcome.unread, ['consumed but receipt-listed']);
    assert.equal(f.session.closed, true);
    assert.equal((await f.inputs()).length, 2);
  } finally {
    await f.session.close();
  }
});

await test('SDK shutdown releases an interrupt waiting for input dispatch', async (t) => {
  const f = await launcher();
  const controller = new AbortController();
  const started = working();
  const session = await f.connect({
    signal: controller.signal,
    onEvent: started.onEvent,
  });
  const write = t.mock.method(f.children[0]!.stdin, 'write');
  try {
    const turn = session.send('wait');
    await within(started.seen, 2000, 'initial input');
    const admission = session.steer('unwritten follow-up');
    controller.abort();
    const interruption = session.interrupt();
    assert.equal(await admission, true);
    await within(interruption, 2000, 'SDK shutdown interrupt');
    assert.equal((await turn).status, 'interrupted');
    assert.equal(
      write.mock.calls.some((call) =>
        String(call.arguments[0]).includes('unwritten follow-up'),
      ),
      false,
    );
  } finally {
    await session.close();
  }
});

await test('native exit settles a turn with unacknowledged input', async () => {
  const f = await background();
  try {
    await f.steer('outstanding');
    f.child.kill('SIGTERM');
    assert.equal((await within(f.turn, 2000, 'native exit')).status, 'failed');
  } finally {
    await f.session.close();
  }
});
