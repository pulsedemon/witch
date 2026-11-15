import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, vi } from 'vitest';
import { TurnText } from '../../../src/agents/turn-text.js';
import { jsonLines, launcher, working } from '../../fixtures/claude-adapter.js';
import { appears, settled, until, within } from '../../fixtures/within.js';
import {
  background,
  lifecycle,
  result,
  state,
} from '../../fixtures/claude-background.js';

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

test('without session state a result finishes the turn and reports missing tracking once', async () => {
  const f = await background(false);

  try {
    await f.emit(result('First answer.', [f.initial]));

    assert.deepEqual(await within(f.turn, 2000, 'result completion'), {
      status: 'completed',
      text: 'First answer.',
    });

    const next = f.session.send('next');
    await until('next input', async () => (await f.inputs()).length === 2);
    await f.emit(result('Second answer.', [(await f.inputs())[1]!.uuid!]));

    assert.deepEqual(await within(next, 2000, 'next result'), {
      status: 'completed',
      text: 'Second answer.',
    });

    assert.equal(
      f.events.filter(
        (e) =>
          e.type === 'notice' && /did not report session state/.test(e.text),
      ).length,
      1,
    );
  } finally {
    await f.session.close();
  }
});

test('a session state received between turns makes subsequent results wait for idle', async () => {
  const f = await background(false);

  try {
    await f.emit(result('First answer.', [f.initial]));
    await within(f.turn, 2000, 'first result');
    await f.emit(state('running'));
    const next = f.session.send('next');
    const isSettled = settled(next);
    await until('next input', async () => (await f.inputs()).length === 2);
    await f.emit(result('Second answer.', [(await f.inputs())[1]!.uuid!]));
    assert.equal(isSettled(), false);
    await f.emit(state('idle'));

    assert.deepEqual(await within(next, 2000, 'native idle'), {
      status: 'completed',
      text: 'Second answer.',
    });
  } finally {
    await f.session.close();
  }
});

test('Claude Code running on its own between turns is reported until it is idle again', async () => {
  const f = await background();

  const reported = () =>
    f.events.flatMap((e) => (e.type === 'running' ? [e.running] : []));

  try {
    await f.emit(result('First answer.'), state('idle'));
    await within(f.turn, 2000, 'first turn');
    const before = reported().length;
    // as Claude Code does when a brew ends after idle
    await f.emit(state('running'), result('Brewed.'), state('idle'));
    assert.deepEqual(reported().slice(before), [true, false]);
  } finally {
    await f.session.close();
  }
});

test("a prompt sent while Claude Code runs on its own settles on its own result, not the run's", async () => {
  const f = await background();

  try {
    await f.emit(state('idle'));
    await within(f.turn, 2000, 'first turn');
    await f.emit(state('running'));
    const next = f.session.send('next');
    const isSettled = settled(next);
    await until('next input', async () => (await f.inputs()).length === 2);
    const uuid = (await f.inputs())[1]!.uuid!;
    // as captured, the run's own result names no input
    await f.emit(lifecycle(uuid, 'queued'), result('Brewed.'), state('idle'));
    assert.equal(isSettled(), false);

    await f.emit(
      state('running'),
      lifecycle(uuid, 'started'),
      result('Next answer.', [uuid]),
      state('idle'),
    );

    assert.deepEqual(await within(next, 2000, 'next result'), {
      status: 'completed',
      text: 'Next answer.',
    });
  } finally {
    await f.session.close();
  }
});

for (const task_type of ['local_agent', 'local_workflow'])
  for (const ending of ['notification', 'live set'])
    test(`without session state a ${task_type} holds the result until its ${ending} ends it`, async () => {
      const f = await background(false);
      const task = { task_id: 'holder', task_type, description: 'Holder' };

      try {
        await f.emit(
          { type: 'system', subtype: 'task_started', ...task },
          {
            type: 'system',
            subtype: 'background_tasks_changed',
            tasks: [task],
          },
          result('Held answer.', [f.initial]),
        );

        assert.equal(f.completions(), 0);
        assert.equal(f.session.replied, true);

        await f.emit(
          ending === 'notification'
            ? {
                type: 'system',
                subtype: 'task_notification',
                task_id: 'holder',
                status: 'completed',
                output_file: '',
                summary: 'Complete',
              }
            : {
                type: 'system',
                subtype: 'background_tasks_changed',
                tasks: [],
              },
        );

        assert.deepEqual(await within(f.turn, 2000, 'last holder'), {
          status: 'completed',
          text: 'Held answer.',
        });

        assert.equal(f.completions(), 1);
      } finally {
        await f.session.close();
      }
    });

test('without session state a stale workflow notification cannot release the current run', async () => {
  const f = await background(false);

  try {
    await f.emit(
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'workflow',
        task_type: 'local_workflow',
        run_id: '2',
        description: 'Current workflow',
      },
      result('Held answer.', [f.initial]),
    );

    const notification = {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'workflow',
      status: 'completed',
      output_file: '',
      summary: 'Complete',
    };

    await f.emit({ ...notification, run_id: '1' });
    assert.equal(f.completions(), 0);
    assert.equal(f.session.replied, true);
    await f.emit({ ...notification, run_id: '2' });

    assert.deepEqual(await within(f.turn, 2000, 'current workflow'), {
      status: 'completed',
      text: 'Held answer.',
    });

    assert.equal(f.completions(), 1);
  } finally {
    await f.session.close();
  }
});

test('without session state an accepted follow-up with no task needs consumption and a fresh result', async () => {
  const f = await background(false);

  try {
    const uuid = await f.steer('follow-up');

    await f.emit(
      result('Initial answer.', [f.initial]),
      lifecycle(uuid, 'queued'),
    );

    assert.equal(f.completions(), 0);
    await f.emit(lifecycle(uuid, 'started'));
    assert.equal(f.completions(), 0);
    await f.emit(result('Follow-up answer.', [uuid]));

    assert.deepEqual(await within(f.turn, 2000, 'follow-up result'), {
      status: 'completed',
      text: 'Follow-up answer.',
    });

    assert.deepEqual(
      (await f.inputs()).map((input) => input.message.content),
      ['initial', 'follow-up'],
    );
  } finally {
    await f.session.close();
  }
});

test('a workflow can hold a normal turn beyond the shutdown budget', async () => {
  const f = await background(false);

  try {
    await f.emit(
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'long-work',
        task_type: 'local_workflow',
        description: 'Long work',
      },
      result('Held answer.', [f.initial]),
    );

    await delay(8100);
    assert.equal(f.completions(), 0);
    assert.equal(f.session.closed, false);

    await f.emit({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'long-work',
      status: 'completed',
      output_file: '',
      summary: 'Complete',
    });

    assert.deepEqual(await within(f.turn, 2000, 'workflow completion'), {
      status: 'completed',
      text: 'Held answer.',
    });
  } finally {
    await f.session.close();
  }
});

for (const commandFirst of [false, true])
  test(`without session state a held command finishing ${commandFirst ? 'before' : 'after'} the last holder sends its reply once`, async () => {
    const f = await background(false);

    try {
      await f.emit(
        {
          type: 'system',
          subtype: 'task_started',
          task_id: 'holder',
          task_type: 'local_agent',
          description: 'Holder',
        },
        result('Initial answer.', [f.initial]),
      );

      const command =
        "printf 'once\\n' >> executions; touch command-started; while [ ! -e command-release ]; do sleep 0.02; done; printf output";

      assert.equal(await f.session.steer('command reply', { command }), true);
      await appears(join(f.cwd, 'command-started'), 'shell start');

      if (commandFirst) {
        await writeFile(join(f.cwd, 'command-release'), '');
        await until('reply input', async () => (await f.inputs()).length === 2);
      }

      await f.emit({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'holder',
        status: 'completed',
        output_file: '',
        summary: 'Complete',
      });

      assert.equal(f.completions(), 0);

      if (!commandFirst) {
        assert.equal((await f.inputs()).length, 1);
        await writeFile(join(f.cwd, 'command-release'), '');
        await until('reply input', async () => (await f.inputs()).length === 2);
      }

      const input = (await f.inputs())[1]!;

      assert.match(
        JSON.stringify(input.message.content),
        /<bash-stdout>output/,
      );

      await f.emit(lifecycle(input.uuid!, 'started'));
      assert.equal(f.completions(), 0);
      await f.emit(result('Command answer.', [input.uuid!]));

      assert.deepEqual(await within(f.turn, 2000, 'command reply result'), {
        status: 'completed',
        text: 'Command answer.',
      });

      assert.equal((await f.inputs()).length, 2);
      assert.equal(await readFile(join(f.cwd, 'executions'), 'utf8'), 'once\n');
    } finally {
      await f.session.close();
    }
  });

test('a steered command reply waits for consumption and a fresh result', async () => {
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
  test(`a correlated result consumes a steered command reply (${singular ? 'single UUID' : 'UUID list'})`, async () => {
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

test('a refused steered command reply fails the Witch turn', async () => {
  const f = await background();

  try {
    const { uuid } = await commandReply(f);
    await f.emit(lifecycle(uuid, 'refused'), state('idle'));
    const outcome = await within(f.turn, 2000, 'refused command reply');
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.error, 'Claude refused a prompt');
  } finally {
    await f.session.close();
  }
});

test('an interrupted command reply recovers output without replaying the command', async () => {
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
  test(`a post-result prompt remains in the Witch turn across native idle (${task ?? 'no task frame'})`, async () => {
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

test('malformed lifecycle frames do not consume a pending prompt', async () => {
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

test('each steered prompt needs its own main-session consumption evidence', async () => {
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

test('a steered prompt that starts with / goes client_composed, and a steered command goes as typed', async () => {
  const f = await background();

  try {
    await f.steer('  /var/folders/xx/a.png\nwhat is this');
    await f.steer('/clear');

    assert.equal(
      await f.session.steer('/review now', {
        skill: { name: 'review', args: 'now' },
      }),
      true,
    );

    await f.steer('plain');

    assert.deepEqual(
      (await f.inputs()).map((input) => [
        input.message.content,
        input.client_composed,
      ]),
      [
        ['initial', undefined],
        ['  /var/folders/xx/a.png\nwhat is this', true],
        ['/clear', true],
        ['/review now', undefined],
        ['plain', undefined],
      ],
    );
  } finally {
    await f.session.close();
  }
});

for (const singular of [false, true]) {
  test(`a correlated result accounts for input without a started event (${singular ? 'single UUID' : 'UUID list'})`, async () => {
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
  test(`missing terminal events cannot hang a failed input${laterReport ? ' or let a later report erase its failure' : ''}${error ? '' : ' with empty error text'}`, async () => {
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
  test(`input ${disposition} before consumption settles failed at native idle`, async () => {
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

test('context updates retain consumption tracking without returning as unread user input', async () => {
  const f = await background();

  try {
    const text = 'Witch coordination update: claim checks are required';
    const context = await f.steer(text, { contextOnly: true });
    await f.emit(state('idle'));
    assert.equal(f.completions(), 0);

    await f.emit(
      state('running'),
      lifecycle(context, 'started'),
      result('Policy consumed.', [context]),
    );

    const user = await f.steer('Real user follow-up');
    await f.emit(state('idle'));
    assert.equal(f.completions(), 0);

    await writeFile(
      join(f.cwd, 'receipt.json'),
      JSON.stringify([context, user]),
    );

    await within(f.session.interrupt(), 2000, 'mixed-input interrupt');
    const outcome = await f.turn;
    assert.equal(outcome.status, 'interrupted');
    assert.deepEqual(outcome.unread, ['Real user follow-up']);
    assert.deepEqual(outcome.unreadContext ?? [], []);
    assert.equal(f.session.closed, true);
  } finally {
    await f.session.close();
  }
});

test('a refused context update preserves the completed user result', async () => {
  const f = await background();

  try {
    const context = await f.steer('Witch coordination update', {
      contextOnly: true,
    });

    await f.emit(state('idle'), lifecycle(context, 'refused'));

    assert.deepEqual(await within(f.turn, 2000, 'context refusal'), {
      status: 'completed',
      text: 'Finished.',
    });

    assert.equal(f.completions(), 1);
    assert.equal(f.session.closed, false);
  } finally {
    await f.session.close();
  }
});

test('an interrupt after the idle gap recovers only native-unread prompts', async () => {
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

test('an interrupt after admission cannot overtake accepted input', async () => {
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

test('an interrupt receipt retains the text of already consumed input', async () => {
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

test('SDK shutdown releases an interrupt waiting for input dispatch', async () => {
  const f = await launcher();
  const controller = new AbortController();
  const started = working();

  const session = await f.connect({
    signal: controller.signal,
    onEvent: started.onEvent,
  });

  const write = vi.spyOn(f.children[0]!.stdin, 'write');

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
        String(call[0]).includes('unwritten follow-up'),
      ),
      false,
    );
  } finally {
    await session.close();
  }
});

test('native exit settles a turn with unacknowledged input', async () => {
  const f = await background();

  try {
    await f.steer('outstanding');
    f.child.kill('SIGTERM');
    assert.equal((await within(f.turn, 2000, 'native exit')).status, 'failed');
  } finally {
    await f.session.close();
  }
});

test('successful native results do not rejoin the accumulated turn text', async () => {
  const f = await background();
  const text = vi.spyOn(TurnText.prototype, 'text', 'get');

  try {
    await f.emit(
      result('First result'),
      result('Second result'),
      state('idle'),
    );

    const outcome = await f.turn;
    assert.equal(outcome.status, 'completed');
    assert.equal(outcome.text, 'Second result');
    assert.equal(text.mock.calls.length, 0);
  } finally {
    text.mockRestore();
    await f.session.close();
  }
});
