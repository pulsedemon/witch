import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { access, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { setImmediate as tick } from 'node:timers/promises';
import { isDeepStrictEqual, promisify } from 'node:util';
import type {
  SDKControlRequest,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from '../src/agents/types.js';
import {
  launcher,
  fixture,
  working,
  jsonLines,
  content,
} from './fixtures/claude-adapter.js';
import { scratch } from './fixtures/scratch.js';
import { until, within } from './fixtures/within.js';

const execute = promisify(execFile);
/** pgrep exits 1 when nothing matches. */
const running = (pattern: string) =>
  execute('pgrep', ['-f', pattern]).then(
    () => true,
    () => false,
  );
const stop = (pattern: string) =>
  execute('pkill', ['-f', pattern]).catch(() => {});

test("a shell command runs in the session's directory as one open tool row, sends Claude nothing, and its record goes ahead of the next prompt once", async () => {
  const tools: Extract<AgentEvent, { type: 'tool' }>[] = [];
  const { session, cwd } = await fixture((event) => {
    if (event.type === 'tool') tools.push(event);
  });
  try {
    assert.deepEqual(
      await within(session.shell('pwd -P'), 3000, 'the command'),
      { status: 'completed', text: '' },
    );
    assert.equal(new Set(tools.map(({ id }) => id)).size, 1);
    assert.equal(tools[0]!.title, 'pwd -P');
    assert.equal(tools[0]!.shell, true);
    assert.equal(tools.at(-1)!.done, true);
    await assert.rejects(access(join(cwd, 'content.json')));
    await session.send('next');
    assert.deepEqual(await content(cwd), [
      {
        type: 'text',
        text: `<bash-input>pwd -P</bash-input>\n<bash-stdout>${await realpath(cwd)}\n</bash-stdout><bash-stderr></bash-stderr>`,
      },
      { type: 'text', text: 'next' },
    ]);
    await session.send('again');
    assert.equal(await content(cwd), 'again');
  } finally {
    await session.close();
  }
});

for (const closed of [false, true]) {
  test(`unsent command context can be taken once ${closed ? 'after close' : 'before the next prompt'}`, async () => {
    const { session, cwd } = await fixture();
    try {
      await session.shell('printf alpha');
      await session.shell('printf beta');
      if (closed) await session.close();
      assert.deepEqual(session.takeUnreadContext!(), [
        '<bash-input>printf alpha</bash-input>\n<bash-stdout>alpha</bash-stdout><bash-stderr></bash-stderr>',
        '<bash-input>printf beta</bash-input>\n<bash-stdout>beta</bash-stdout><bash-stderr></bash-stderr>',
      ]);
      assert.deepEqual(session.takeUnreadContext!(), []);
      if (!closed) {
        await session.send('next');
        assert.equal(await content(cwd), 'next');
      }
    } finally {
      await session.close();
    }
  });
}

for (const condition of [
  'written',
  'backpressure',
  'throwing writer',
  'control before input',
]) {
  test(`dispatch failure recovers only unwritten command context (${condition})`, async () => {
    const { session, cwd, child } = await fixture(undefined, 'hold-initial');
    const command = "printf 'boundary-output\\n'";
    const record = `<bash-input>${command}</bash-input>\n<bash-stdout>boundary-output\n</bash-stdout><bash-stderr></bash-stderr>`;
    try {
      await session.shell(command);
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = (...args) => {
        const frame = JSON.parse(String(args[0])) as
          SDKControlRequest | SDKUserMessage;
        const result = Reflect.apply(write, child.stdin, args) as boolean;
        if (
          condition === 'control before input' &&
          frame.type === 'control_request' &&
          frame.request.subtype === 'get_context_usage'
        )
          assert.equal(child.kill('SIGTERM'), true);
        return condition === 'backpressure' && frame.type === 'user'
          ? false
          : result;
      };
      if (condition === 'throwing writer') {
        const write = child.stdin._write.bind(child.stdin);
        child.stdin._write = (chunk, encoding, callback) => {
          const frame = JSON.parse(String(chunk)) as SDKUserMessage;
          if (frame.type === 'user') throw new Error('fixture write failure');
          write(chunk, encoding, callback);
        };
      }
      const turn = session.send('reply');
      if (condition === 'control before input') await session.contextUsage();
      else if (condition !== 'throwing writer') {
        await until('the written command frame', async () => {
          const frames = (await jsonLines(
            join(cwd, 'held.json'),
          )) as SDKUserMessage[];
          return frames.some((frame) =>
            JSON.stringify(frame.message.content).includes('<bash-input>'),
          );
        });
        assert.equal(child.kill('SIGTERM'), true);
      }
      const result = await within(turn, 5000, 'the failed command reply');
      assert.equal(result.status, 'failed');
      assert.deepEqual(
        result.unreadContext ?? [],
        condition === 'control before input' ? [record] : [],
      );
      assert.equal(
        result.inputUnsent,
        condition === 'control before input' ? true : undefined,
      );
      assert.deepEqual(session.takeUnreadContext!(), []);
    } finally {
      await session.close();
      assert.ok(child.exitCode !== null || child.signalCode !== null);
    }
  });
}

test('dispatch failure recovers only the later unsent command in a turn', async () => {
  const { connect, children, cwd } = await launcher();
  let commands = 0;
  const session = await connect({
    onShell: async (pid) => {
      if (pid === undefined && ++commands === 2)
        assert.equal(children[0]!.kill('SIGTERM'), true);
    },
  });
  try {
    const turn = session.send('reporting familiar');
    await until('the first reply', () => session.replied);
    assert.equal(
      await session.steer('first reply', { command: 'printf alpha' }),
      true,
    );
    await until(
      'the written first command',
      async () => (await jsonLines(join(cwd, 'steered.jsonl'))).length === 1,
    );
    await session.contextUsage();
    assert.equal(
      await session.steer('second reply', { command: 'printf beta' }),
      true,
    );
    const result = await within(turn, 5000, 'the failed second reply');
    assert.equal(result.status, 'failed');
    assert.equal(result.inputUnsent, undefined);
    assert.deepEqual(result.unreadContext, [
      '<bash-input>printf beta</bash-input>\n<bash-stdout>beta</bash-stdout><bash-stderr></bash-stderr>',
    ]);
    assert.deepEqual(session.takeUnreadContext!(), []);
    assert.equal((await jsonLines(join(cwd, 'steered.jsonl'))).length, 1);
  } finally {
    await session.close();
    assert.ok(
      children.every(
        (child) => child.exitCode !== null || child.signalCode !== null,
      ),
    );
  }
});

test("a shell command refuses steering, and an interrupt kills it, ends it interrupted and keeps its record for the next prompt with the next command's", async () => {
  const output: string[] = [];
  const { session, cwd } = await fixture((event) => {
    if (event.type === 'tool') output.push(event.text);
  });
  try {
    const shell = session.shell('echo started; sleep 60.139');
    await until('the command starts', () =>
      output.join('').includes('started'),
    );
    assert.equal(await session.steer('more'), false);
    await session.interrupt();
    assert.equal(
      (await within(shell, 3000, 'the interrupted command')).status,
      'interrupted',
    );
    await until('the sleep ends', async () => !(await running('sleep 60.139')));
    assert.equal(
      (await within(session.shell('echo second'), 3000, 'the next command'))
        .status,
      'completed',
    );
    await session.send('next');
    const blocks = JSON.parse(
      await readFile(join(cwd, 'content.json'), 'utf8'),
    ) as { text: string }[];
    assert.equal(blocks.length, 3);
    assert.ok(
      blocks[0]!.text.endsWith(
        '<bash-stderr>started\n[Request interrupted by user]</bash-stderr>',
      ),
      blocks[0]!.text,
    );
    assert.equal(
      blocks[1]!.text,
      '<bash-input>echo second</bash-input>\n<bash-stdout>second\n</bash-stdout><bash-stderr></bash-stderr>',
    );
    assert.equal(blocks[2]!.text, 'next');
  } finally {
    await stop('sleep 60.139');
    await session.close();
  }
});

test('closing the session during a shell command kills it, and the shell settles without throwing', async () => {
  const tools: Extract<AgentEvent, { type: 'tool' }>[] = [];
  const { session } = await fixture((event) => {
    if (event.type === 'tool') tools.push(event);
  });
  try {
    const shell = session.shell('sleep 60.141');
    await until('the command row', () => tools.length > 0);
    await session.close();
    await within(shell, 3000, 'the closed command');
    await until('the sleep ends', async () => !(await running('sleep 60.141')));
  } finally {
    await stop('sleep 60.141');
    if (!session.closed) await session.close();
  }
});

test('close waits for the interrupted command record when a detached child holds its output pipe', async () => {
  let output = '';
  const { session, cwd } = await fixture((event) => {
    if (event.type === 'tool') output += event.text;
  });
  const command = `'${process.execPath.replaceAll("'", "'\\''")}' pipe-holder.cjs`;
  let shell: ReturnType<typeof session.shell> | undefined;
  let pipePid: number | undefined;
  try {
    await writeFile(
      join(cwd, 'pipe-holder.cjs'),
      `const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 700)'], {
  detached: true,
  stdio: ['ignore', 'inherit', 'inherit'],
});
writeFileSync('pipe.pid', String(child.pid));
child.unref();
process.stdout.write('partial-output\\n');
setInterval(() => {}, 1000);
`,
    );
    shell = session.shell(command);
    await until('the command output', () => output.includes('partial-output'));
    pipePid = Number(await readFile(join(cwd, 'pipe.pid'), 'utf8'));
    await within(session.close(), 3000, 'session close');
    assert.deepEqual(session.takeUnreadContext!(), [
      `<bash-input>${command}</bash-input>\n<bash-stdout></bash-stdout><bash-stderr>partial-output\n[Request interrupted by user]</bash-stderr>`,
    ]);
    assert.equal((await shell).status, 'interrupted');
    assert.deepEqual(session.takeUnreadContext!(), []);
  } finally {
    await session.close();
    if (shell) await within(shell, 3000, 'the interrupted command');
    const pid = pipePid;
    if (pid)
      await until('the pipe holder exits', () => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
          throw error;
        }
      });
  }
});

for (const fails of [false, true]) {
  test(`close waits for the final shell report to ${fails ? 'reject' : 'finish'} before clearing the native process`, async () => {
    const reporting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const reports: string[] = [];
    const { connect, children } = await launcher();
    const session = await connect({
      onShell: async (pid) => {
        if (pid !== undefined) return;
        reporting.resolve();
        await release.promise;
        reports.push('shell');
        if (fails) throw new Error('shell report failed');
      },
      onProcess: async (pid) => {
        if (pid === undefined) reports.push('native');
      },
    });
    const nativeClosed = once(children[0]!, 'close');
    const shell = session.shell('printf reported');
    const result = fails
      ? assert.rejects(shell, /shell report failed/)
      : shell.then((result) => assert.equal(result.status, 'completed'));
    try {
      await within(reporting.promise, 3000, 'the final shell report');
      const closing = session.close();
      await within(nativeClosed, 3000, 'the native process exit');
      await tick();
      assert.deepEqual(reports, []);
      release.resolve();
      await within(Promise.all([closing, result]), 3000, 'session close');
      assert.deepEqual(reports, ['shell', 'native']);
    } finally {
      release.resolve();
      await session.close();
      await result;
    }
  });
}

test("a shell command reports its shell's pid as it starts and undefined once it ends, after the start's report settles", async () => {
  const done = Promise.withResolvers<void>();
  const texts: string[] = [];
  const reports: string[] = [];
  const { connect } = await launcher();
  const session = await connect({
    onEvent: (event) => {
      if (event.type !== 'tool') return;
      texts.push(event.text);
      if (event.done) done.resolve();
    },
    onShell: async (pid) => {
      reports.push(`report ${pid}`);
      if (pid === undefined) return;
      // throws once the shell is reaped
      process.kill(pid, 0);
      // still pending when the command ends, however fast it runs
      await done.promise;
      reports.push('settled');
    },
  });
  try {
    await within(session.shell('echo $$'), 3000, 'the command');
    const pid = Number(texts.join('').trim());
    assert.deepEqual(reports, [`report ${pid}`, 'settled', 'report undefined']);
  } finally {
    await session.close();
  }
});

test('a shell report that rejects fails the command once it ends, without an unhandled rejection', async () => {
  const texts: string[] = [];
  const { connect } = await launcher();
  const session = await connect({
    onEvent: (event) => {
      if (event.type === 'tool') texts.push(event.text);
    },
    onShell: async (pid) => {
      if (pid !== undefined) throw new Error('no shell record');
    },
  });
  try {
    await assert.rejects(
      session.shell('sleep 0.3; echo ended'),
      /no shell record/,
    );
    assert.equal(texts.join(''), 'ended\n');
  } finally {
    await session.close();
  }
});

/** what a session reports, for the commands steered after a reply. */
function observe() {
  const texts: string[] = [];
  const tools: Extract<AgentEvent, { type: 'tool' }>[] = [];
  const skills: string[] = [];
  const notices: string[] = [];
  const onEvent = (event: AgentEvent) => {
    if (event.type === 'text') texts.push(event.text);
    else if (event.type === 'tool') tools.push(event);
    else if (event.type === 'skills')
      skills.push(...event.skills.map(({ name }) => name));
    else if (event.type === 'notice') notices.push(event.text);
  };
  /** whether the shell row the command opened is done. */
  const ended = (command: string) => {
    const id = tools.find(({ title }) => title === command)?.id;
    return tools.some((tool) => tool.id === id && tool.done);
  };
  return { texts, tools, skills, notices, onEvent, ended };
}

/** the blocks a steered command's reply goes as, its record first. */
const replyBlocks = (command: string, stdout: string) => [
  {
    type: 'text',
    text: `<bash-input>${command}</bash-input>\n<bash-stdout>${stdout}</bash-stdout><bash-stderr></bash-stderr>`,
  },
  { type: 'text', text: 'reply' },
];

const allow = (cwd: string, ...names: string[]) =>
  Promise.all(names.map((name) => writeFile(join(cwd, name), 'yes')));
const gated = 'until [ -e go ]; do sleep 0.05; done; echo held';

test('a command steered after the result runs, refuses other prompts while it runs, then steers its record and reply', async () => {
  const seen = observe();
  const { session, cwd } = await fixture(seen.onEvent);
  try {
    const turn = session.send('background familiar');
    await until('the result', () => seen.skills.includes('result-1'));
    assert.equal(await session.steer('reply', { command: gated }), true);
    await until('the command row', () =>
      seen.tools.some(({ title }) => title === gated),
    );
    assert.equal(session.replied, false);
    assert.equal(await session.steer('more'), false);
    await allow(cwd, 'go');
    const steered = join(cwd, 'steered.jsonl');
    const expected = [replyBlocks(gated, 'held\n')];
    await until('the reply', async () =>
      isDeepStrictEqual(await jsonLines(steered), expected),
    );
    await allow(cwd, 'allow-idle');
    assert.equal((await within(turn, 2000, 'turn')).status, 'completed');
    assert.deepEqual(await jsonLines(steered), expected);
  } finally {
    await session.close();
  }
});

test("a turn whose familiar reports while a steered command runs stays open through Claude Code's idle until the command's reply is answered", async () => {
  const seen = observe();
  const { session, cwd } = await fixture(seen.onEvent);
  try {
    let finished = false;
    const turn = session.send('reporting familiar').then((result) => {
      finished = true;
      return result;
    });
    await until('the result', () => seen.skills.includes('result-1'));
    assert.equal(await session.steer('reply', { command: gated }), true);
    await allow(cwd, 'allow-report', 'allow-idle');
    await until('idle', () => seen.skills.includes('after-idle'));
    assert.equal(finished, false);
    await allow(cwd, 'go');
    assert.equal((await within(turn, 3000, 'turn')).status, 'completed');
    assert.deepEqual(await content(cwd), replyBlocks(gated, 'held\n'));
  } finally {
    await session.close();
  }
});

test("a command that ends while Claude Code answers the familiar's report sends its reply only once Claude Code is idle", async () => {
  const seen = observe();
  const { session, cwd } = await fixture(seen.onEvent);
  try {
    const turn = session.send('reporting familiar');
    await until('the result', () => seen.skills.includes('result-1'));
    assert.equal(await session.steer('reply', { command: gated }), true);
    await allow(cwd, 'allow-report');
    await until('the report', () => seen.texts.includes('Reported.'));
    await allow(cwd, 'go');
    await until('the command ends', () => seen.ended(gated));
    // time for a reply sent too early to reach the fixture
    await new Promise((resolve) => setTimeout(resolve, 200));
    await allow(cwd, 'allow-idle');
    assert.equal((await within(turn, 3000, 'turn')).status, 'completed');
    assert.deepEqual(await content(cwd), replyBlocks(gated, 'held\n'));
    await assert.rejects(access(join(cwd, 'early.jsonl')));
  } finally {
    await session.close();
  }
});

test('a command that ends while Claude Code runs again after idle sends its reply only once Claude Code is idle again', async () => {
  const seen = observe();
  const { session, cwd } = await fixture(seen.onEvent);
  try {
    const turn = session.send('reporting familiar');
    await until('the result', () => seen.skills.includes('result-1'));
    assert.equal(await session.steer('reply', { command: gated }), true);
    await allow(cwd, 'allow-report', 'allow-idle');
    await until('idle', () => seen.skills.includes('after-idle'));
    await allow(cwd, 'allow-run');
    await until('the run', () => seen.texts.includes('Brewed.'));
    await allow(cwd, 'go');
    await until('the command ends', () => seen.ended(gated));
    // time for a reply sent too early to reach the fixture
    await new Promise((resolve) => setTimeout(resolve, 200));
    await allow(cwd, 'allow-rest');
    assert.equal((await within(turn, 3000, 'turn')).status, 'completed');
    assert.deepEqual(await content(cwd), replyBlocks(gated, 'held\n'));
    await assert.rejects(access(join(cwd, 'early.jsonl')));
  } finally {
    await session.close();
  }
});

test("a reply waiting for Claude Code's idle goes once Claude Code starts another familiar", async () => {
  const seen = observe();
  const { session, cwd } = await fixture(seen.onEvent);
  try {
    const turn = session.send('reporting familiar');
    await until('the result', () => seen.skills.includes('result-1'));
    assert.equal(await session.steer('reply', { command: gated }), true);
    await allow(cwd, 'allow-report');
    await until('the report', () => seen.texts.includes('Reported.'));
    await allow(cwd, 'go');
    await until('the command ends', () => seen.ended(gated));
    await allow(cwd, 'allow-second');
    await until('the reply', async () =>
      isDeepStrictEqual(await jsonLines(join(cwd, 'early.jsonl')), [
        replyBlocks(gated, 'held\n'),
      ]),
    );
    assert.equal((await within(turn, 3000, 'turn')).status, 'completed');
  } finally {
    await session.close();
  }
});

test('an interrupt during a steered command after Claude Code is idle kills it and ends the turn interrupted, sending the idle CLI no interrupt and no reply', async () => {
  const seen = observe();
  const { session, cwd } = await fixture(seen.onEvent);
  try {
    const turn = session.send('reporting familiar');
    await until('the result', () => seen.skills.includes('result-1'));
    assert.equal(
      await session.steer('reply', { command: 'sleep 60.38' }),
      true,
    );
    await until('the sleep starts', () => running('sleep 60.38'));
    await allow(cwd, 'allow-report', 'allow-idle');
    await until('idle', () => seen.skills.includes('after-idle'));
    await within(session.interrupt(), 3000, 'interrupt');
    assert.equal((await within(turn, 2000, 'turn')).status, 'interrupted');
    await assert.rejects(access(join(cwd, 'interrupts.log')));
    assert.equal(await content(cwd), 'reporting familiar');
    await until('the sleep ends', async () => !(await running('sleep 60.38')));
  } finally {
    await stop('sleep 60.38');
    await session.close();
  }
});

test('an interrupt after the reply while a familiar holds the turn open ends the turn interrupted, though Claude Code sends no fresh result', async () => {
  const seen = observe();
  const { session } = await fixture(seen.onEvent);
  try {
    const turn = session.send('background familiar');
    await until('the result', () => seen.skills.includes('result-1'));
    await within(session.interrupt(), 2000, 'interrupt');
    assert.deepEqual(await within(turn, 2000, 'turn'), {
      status: 'interrupted',
      text: 'Finished.',
    });
  } finally {
    await session.close();
  }
});

test('a model change waits for the turn, unless it has replied and a familiar holds it open', async () => {
  const busy = working();
  const seen = observe();
  const { session, cwd } = await fixture((event) => {
    busy.onEvent(event);
    seen.onEvent(event);
  });
  try {
    const first = session.send('steerable');
    await within(busy.seen, 2000, 'first output');
    assert.equal(session.replied, false);
    await assert.rejects(
      session.selectModel('claude-b'),
      /Stop the current turn/,
    );
    assert.equal(await session.steer('wrap up'), true);
    await within(first, 2000, 'the first turn');
    const second = session.send('background familiar');
    await until('the result', () => seen.skills.includes('result-2'));
    assert.equal(session.replied, true);
    await session.selectModel('claude-b');
    assert.equal(session.info.model, 'claude-b');
    assert.equal(await session.steer('meanwhile'), true);
    await allow(cwd, 'allow-idle');
    assert.equal((await within(second, 2000, 'turn')).status, 'completed');
  } finally {
    await session.close();
  }
});

for (const mode of [undefined, 'first-reply-read']) {
  test(
    mode
      ? 'an interrupt recovers only command records named by its receipt'
      : 'an interrupt returns unread command records separately from ordinary prompts',
    async () => {
      const { session, cwd } = await fixture(undefined, mode);
      const records = [
        "<bash-input>printf 'alpha\\n'</bash-input>\n<bash-stdout>alpha\n</bash-stdout><bash-stderr></bash-stderr>",
        "<bash-input>printf 'beta\\n' >&2; exit 7</bash-input>\n<bash-stdout></bash-stdout><bash-stderr>beta\nExit code 7</bash-stderr>",
      ];
      try {
        const turn = session.send('reporting familiar');
        await until('the first reply', () => session.replied);
        const first = "printf 'alpha\\n'";
        assert.equal(
          await session.steer(`!${first}\n\nReply without running it again.`, {
            command: first,
          }),
          true,
        );
        await until(
          'the first command reply',
          async () =>
            (await jsonLines(join(cwd, 'steered.jsonl'))).length === 1,
        );
        assert.equal(await session.steer('between'), true);
        const second = "printf 'beta\\n' >&2; exit 7";
        assert.equal(
          await session.steer(`!${second}\n\nReply without running it again.`, {
            command: second,
          }),
          true,
        );
        await until(
          'the second command reply',
          async () =>
            (await jsonLines(join(cwd, 'steered.jsonl'))).length === 3,
        );
        await within(session.interrupt(), 3000, 'interrupt');
        const result = await within(turn, 2000, 'turn');
        assert.equal(result.status, 'interrupted');
        assert.deepEqual(result.unread, ['between']);
        assert.deepEqual(result.unreadContext, mode ? [records[1]] : records);
        assert.deepEqual(session.takeUnreadContext!(), []);
        assert.equal(session.closed, true);
      } finally {
        await session.close();
      }
    },
  );
}

test('an interrupt recovers a completed idle command from its initial reply', async () => {
  const { session, cwd } = await fixture(undefined, 'hold-initial');
  const command = "printf 'once\\n' >> executions; printf 'initial-output\\n'";
  const record = `<bash-input>${command}</bash-input>\n<bash-stdout>initial-output\n</bash-stdout><bash-stderr></bash-stderr>`;
  try {
    assert.equal((await session.shell(command)).status, 'completed');
    const prompt = `!${command}\n\nReply without running it again.`;
    const turn = session.send(prompt);
    await until(
      'the initial reply',
      async () => (await jsonLines(join(cwd, 'held.json'))).length === 1,
    );
    const input = JSON.parse(
      await readFile(join(cwd, 'held.json'), 'utf8'),
    ) as {
      message: { content: unknown };
    };
    assert.deepEqual(input.message.content, [
      { type: 'text', text: record },
      { type: 'text', text: prompt },
    ]);
    await within(session.interrupt(), 3000, 'interrupt');
    const result = await within(turn, 2000, 'turn');
    assert.equal(result.status, 'interrupted');
    assert.deepEqual(result.unread, []);
    assert.deepEqual(result.unreadContext, [record]);
    assert.deepEqual(session.takeUnreadContext!(), []);
    assert.equal(await readFile(join(cwd, 'executions'), 'utf8'), 'once\n');
    assert.equal(session.closed, true);
  } finally {
    await session.close();
  }
});

test("a turn stays open while a steered command's end report is still settling", async () => {
  const seen = observe();
  const settled = Promise.withResolvers<void>();
  const { cwd, connect } = await launcher();
  const session = await connect({
    onEvent: seen.onEvent,
    onShell: async (pid) => {
      if (pid === undefined) await settled.promise;
    },
  });
  try {
    let finished = false;
    const turn = session.send('reporting familiar').then((result) => {
      finished = true;
      return result;
    });
    await until('the result', () => seen.skills.includes('result-1'));
    assert.equal(
      await session.steer('reply', { command: 'echo settled' }),
      true,
    );
    await until('the command ends', () => seen.ended('echo settled'));
    await allow(cwd, 'allow-report', 'allow-idle');
    await until('idle', () => seen.skills.includes('after-idle'));
    assert.equal(finished, false);
    settled.resolve();
    assert.equal((await within(turn, 3000, 'turn')).status, 'completed');
    assert.deepEqual(
      await content(cwd),
      replyBlocks('echo settled', 'settled\n'),
    );
  } finally {
    settled.resolve();
    await session.close();
  }
});

test('a steered command that fails posts its error and sends no reply', async () => {
  const seen = observe();
  const { cwd, connect } = await launcher();
  const session = await connect({
    onEvent: seen.onEvent,
    onShell: async (pid) => {
      if (pid !== undefined) throw new Error('no shell record');
    },
  });
  try {
    const turn = session.send('background familiar');
    await until('the result', () => seen.skills.includes('result-1'));
    assert.equal(
      await session.steer('reply', { command: 'echo failed' }),
      true,
    );
    await until('the notice', () =>
      seen.notices.some((text) => /no shell record/.test(text)),
    );
    assert.equal(await session.steer('meanwhile'), true);
    await allow(cwd, 'allow-idle');
    assert.equal((await within(turn, 2000, 'turn')).status, 'completed');
    assert.equal(
      await readFile(join(cwd, 'steered.jsonl'), 'utf8'),
      '"meanwhile"\n',
    );
  } finally {
    await session.close();
  }
});

test('a held turn fails when the CLI dies after idle, and its steered command stops', async () => {
  const seen = observe();
  const { session, cwd } = await fixture(seen.onEvent);
  try {
    const turn = session.send('reporting familiar');
    await until('the result', () => seen.skills.includes('result-1'));
    assert.equal(
      await session.steer('reply', { command: 'sleep 60.39' }),
      true,
    );
    await until('the sleep starts', () => running('sleep 60.39'));
    await allow(cwd, 'allow-report', 'allow-idle');
    await until('idle', () => seen.skills.includes('after-idle'));
    await allow(cwd, 'allow-die');
    const result = await within(turn, 3000, 'turn');
    assert.equal(result.status, 'failed');
    // only end() adds the stderr tail
    assert.match(result.error ?? '', /grandchild line/);
    await until('the sleep ends', async () => !(await running('sleep 60.39')));
  } finally {
    await stop('sleep 60.39');
    await session.close();
  }
});

test('a shell command run with no turn open keeps running when the CLI dies', async () => {
  const seen = observe();
  const { session, cwd } = await fixture(seen.onEvent);
  try {
    const turn = session.send('reporting familiar');
    await until('the result', () => seen.skills.includes('result-1'));
    await allow(cwd, 'allow-report', 'allow-idle');
    assert.equal((await within(turn, 2000, 'turn')).status, 'completed');
    const shell = session.shell('sleep 1; echo done');
    await until('the command row', () =>
      seen.tools.some(({ title }) => title === 'sleep 1; echo done'),
    );
    await allow(cwd, 'allow-die');
    await until('the CLI dies', () => session.closed);
    assert.equal((await within(shell, 3000, 'command')).status, 'completed');
    assert.match(seen.tools.map(({ text }) => text).join(''), /done/);
  } finally {
    await session.close();
  }
});

test('an interrupt while a command that ended waits for idle sends no reply', async () => {
  const seen = observe();
  const { session, cwd } = await fixture(seen.onEvent);
  try {
    const turn = session.send('reporting familiar');
    await until('the result', () => seen.skills.includes('result-1'));
    assert.equal(await session.steer('reply', { command: gated }), true);
    await allow(cwd, 'allow-report');
    await until('the report', () => seen.texts.includes('Reported.'));
    await allow(cwd, 'go');
    await until('the command ends', () => seen.ended(gated));
    await within(session.interrupt(), 3000, 'interrupt');
    assert.equal((await within(turn, 2000, 'turn')).status, 'interrupted');
    await assert.rejects(access(join(cwd, 'early.jsonl')));
    assert.equal(await content(cwd), 'reporting familiar');
  } finally {
    await session.close();
  }
});

const mark = { environment: { WITCH_JOBS: '/x/jobs' }, script: '/x/jobs/env' };

/** runs `body` with another instance's mark in Witch's environment, as when Witch runs inside an agent's command. */
async function insideAnotherWitch(body: () => Promise<void>) {
  const outer = process.env.WITCH_JOBS;
  process.env.WITCH_JOBS = '/outer/jobs/1';
  try {
    await body();
  } finally {
    if (outer === undefined) delete process.env.WITCH_JOBS;
    else process.env.WITCH_JOBS = outer;
  }
}

test("Claude Code gets the mark's script as CLAUDE_ENV_FILE, and the CLI doesn't get the mark", async () => {
  await insideAnotherWitch(async () => {
    const { envs, connect } = await launcher();
    const session = await connect({ mark });
    try {
      assert.equal(envs[0]!.CLAUDE_ENV_FILE, '/x/jobs/env');
      assert.equal(envs[0]!.WITCH_JOBS, '/outer/jobs/1');
    } finally {
      await session.close();
    }
  });
});

test("a ! command's shell gets the mark's environment over Witch's", async (t) => {
  const temporary = await scratch('witch-shell-environment-');
  const previous = process.env.TMPDIR;
  t.onTestFinished(() => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  });
  process.env.TMPDIR = temporary;
  await insideAnotherWitch(async () => {
    const texts: string[] = [];
    const { connect } = await launcher();
    const session = await connect({
      mark,
      onEvent: (event) => {
        if (event.type === 'tool') texts.push(event.text);
      },
    });
    try {
      await within(
        session.shell('printf "%s|%s" "$WITCH_JOBS" "$TMPDIR"'),
        3000,
        'the command',
      );
      assert.equal(texts.join(''), `/x/jobs|${temporary}`);
    } finally {
      await session.close();
    }
  });
});
