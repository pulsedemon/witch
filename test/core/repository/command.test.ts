import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, vi } from 'vitest';
import { runCommand } from '../../../src/core/repository/command.js';
import { ps } from '../../../src/persistence/process.js';
import type * as Process from '../../../src/persistence/process.js';
import { scratch } from '../../fixtures/scratch.js';
import { until, within } from '../../fixtures/within.js';

vi.mock('../../../src/persistence/process.js', { spy: true });

const actual = await vi.importActual<typeof Process>(
  '../../../src/persistence/process.js',
);

for (const cancellable of [false, true])
  test(`commands preserve cwd, arguments and environment in returned output (cancellable: ${cancellable})`, async () => {
    const directory = await scratch('witch-command-');

    const result = await runCommand(
      process.execPath,
      [
        '-e',
        'console.log(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(1), gitTerminalPrompt: process.env.GIT_TERMINAL_PROMPT }))',
        'first',
        'second',
      ],
      {
        cwd: directory,
        timeout: 5000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        ...(cancellable ? { signal: new AbortController().signal } : {}),
      },
    );

    assert.deepEqual(JSON.parse(result.stdout), {
      cwd: directory,
      args: ['first', 'second'],
      gitTerminalPrompt: '0',
    });
  });

test('a cancelled command cannot start another checkout mutation', async () => {
  const cwd = await scratch('witch-command-');
  const signal = AbortSignal.abort();

  await assert.rejects(
    runCommand(
      process.execPath,
      ['-e', "require('node:fs').writeFileSync('mutation', 'ran')"],
      { cwd, timeout: 5000, signal },
    ),
    { name: 'AbortError' },
  );

  await assert.rejects(readFile(join(cwd, 'mutation')), { code: 'ENOENT' });
});

test('a cancellable command counts bytes across stream chunks', async () => {
  const cwd = await scratch('witch-command-');

  await assert.rejects(
    runCommand(
      process.execPath,
      ['-e', "process.stdout.write('é'.repeat(65537))"],
      {
        cwd,
        timeout: 5000,
        signal: new AbortController().signal,
        maxBuffer: 64 * 1024 + 1,
      },
    ),
    {
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      message: /stdout maxBuffer length exceeded/,
    },
  );
});

test('a cancellable command counts bytes before decoding malformed UTF-8', async () => {
  const cwd = await scratch('witch-command-');

  const { stdout } = await runCommand(
    process.execPath,
    ['-e', 'process.stdout.write(Buffer.alloc(16, 255))'],
    {
      cwd,
      timeout: 5000,
      signal: new AbortController().signal,
      maxBuffer: 16,
    },
  );

  assert.equal(stdout, '�'.repeat(16));
});

for (const killSignal of [undefined, 'SIGKILL'] as const) {
  test(`native timeout failures retain their output and metadata (${killSignal ?? 'default signal'})`, async () => {
    const cwd = await scratch('witch-command-');

    await assert.rejects(
      runCommand(
        process.execPath,
        [
          '-e',
          "process.stdout.write('stdout marker'); process.stderr.write('stderr marker'); setTimeout(() => process.exit(29), 10000)",
        ],
        { cwd, timeout: 1500, ...(killSignal ? { killSignal } : {}) },
      ),
      {
        message: /^Timed out after 1500 ms: Command failed:/,
        killed: true,
        code: null,
        signal: killSignal ?? 'SIGTERM',
        stdout: 'stdout marker',
        stderr: 'stderr marker',
      },
    );
  });
}

test('timeout failures remain labeled when the child handles SIGTERM', async () => {
  const cwd = await scratch('witch-command-');

  await assert.rejects(
    runCommand(
      process.execPath,
      [
        '-e',
        "process.on('SIGTERM', () => process.exit(23)); process.stdout.write('ready'); process.stderr.write('handled stderr'); setTimeout(() => process.exit(29), 10000)",
      ],
      { cwd, timeout: 1500 },
    ),
    {
      message: /^Timed out after 1500 ms: Command failed:/,
      killed: true,
      code: 23,
      signal: null,
      stdout: 'ready',
      stderr: 'handled stderr',
    },
  );
});

for (const cancellable of [false, true])
  test(`other command failures keep their native diagnostics (cancellable: ${cancellable})`, async () => {
    const cwd = await scratch('witch-command-');

    for (const [command, script, fields] of [
      [
        process.execPath,
        "process.kill(process.pid, 'SIGTERM')",
        { code: null, signal: 'SIGTERM', killed: false },
      ],
      [
        process.execPath,
        "process.stdout.write('x'.repeat(1100000)); setTimeout(() => process.exit(29), 10000)",
        { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' },
      ],
      [
        process.execPath,
        "process.stdout.write('ordinary stdout'); process.stderr.write('ordinary stderr'); process.exit(23)",
        {
          code: 23,
          killed: false,
          stdout: 'ordinary stdout',
          stderr: 'ordinary stderr',
        },
      ],
      [join(cwd, 'missing'), '', { code: 'ENOENT' }],
    ] as const) {
      await assert.rejects(
        runCommand(command, ['-e', script], {
          cwd,
          timeout: 5000,
          ...(cancellable ? { signal: new AbortController().signal } : {}),
        }),
        { message: /^(?!Timed out after )/, ...fields },
      );
    }
  });

/** a zombie doesn't count, since `kill(pid, 0)` still answers for one on Linux. */
const running = async (pid: number) =>
  (await ps('stat=', [pid])).some((state) => !state.trim().startsWith('Z'));

/** starts a descendant that leaves the group and keeps the command's pipes, then waits for its pid file. */
const outside = (before = '') =>
  `perl -MPOSIX -e '${before}setsid; open my $f, ">", "outside.tmp"; print $f $$; close $f; rename "outside.tmp", "outside.pid"; sleep 30' & until [ -s outside.pid ]; do sleep 0.05; done`;

/**
 * runs a shell script that writes `leader.pid` last and exits, recording every group signal with its answer. the
 * script names what it leaves behind in `outside.pid` and `member.pid`. with `exits` off, the script writes
 * `leader.pid` itself and keeps running. `lost` group kills are recorded and never delivered.
 */
async function left(
  script: string,
  { timeout = 10_000, exits = true, lost = 0 } = {},
) {
  const cwd = await scratch('witch-command-');
  const kill = process.kill.bind(process);
  const sent: [group: number, signal: unknown, answer: string][] = [];

  const spy = vi
    .spyOn(process, 'kill')
    .mockImplementation((pid: number, signal?: string | number) => {
      if (pid >= 0) return kill(pid, signal);

      if (signal === 'SIGKILL' && lost-- > 0) {
        sent.push([-pid, signal, 'lost']);

        return true;
      }

      try {
        kill(pid, signal);
        sent.push([-pid, signal, 'ok']);

        return true;
      } catch (error) {
        sent.push([-pid, signal, (error as NodeJS.ErrnoException).code!]);

        throw error;
      }
    });

  const controller = new AbortController();

  const run = runCommand('sh', ['-c', `${script}; echo $$ > leader.pid`], {
    cwd,
    timeout,
    signal: controller.signal,
  });

  // a failed wait below must not leave the rejection unhandled
  run.catch(() => {});

  const pid = (name: string): number | undefined => {
    try {
      return (
        Number(readFileSync(join(cwd, `${name}.pid`), 'utf8')) || undefined
      );
    } catch {
      return undefined;
    }
  };

  try {
    await until(`the command to ${exits ? 'exit' : 'start'}`, async () => {
      const leader = pid('leader');

      return leader !== undefined && (await running(leader)) !== exits;
    });
  } catch (error) {
    await close();

    throw error;
  }

  const group = pid('leader')!;

  async function close() {
    // never the leader: it has exited, so its id can be someone else's
    for (const name of ['outside', 'member']) {
      const straggler = pid(name);

      if (straggler !== undefined && (await running(straggler)))
        kill(straggler, 'SIGKILL');
    }

    controller.abort();
    await run.catch(() => {});
    spy.mockRestore();
  }

  return {
    cwd,
    run,
    pid,
    abort: () => controller.abort(),
    /** the signals sent to the command's group, each with its answer. */
    signals: () =>
      sent
        .filter(([named]) => named === group)
        .map(([, signal, answer]) => `${String(signal)} ${answer}`),
    close,
  };
}

const probesOnly = (signals: string[]) =>
  assert.deepEqual(
    signals.filter((signal) => !signal.startsWith('0 ')),
    [],
  );

for (const trigger of ['abort', 'timeout'] as const)
  test(`a group that emptied at the command's exit is never signalled by a later ${trigger}`, async () => {
    const command = await left(
      outside(),
      trigger === 'timeout' ? { timeout: 2000 } : {},
    );

    try {
      if (trigger === 'abort') command.abort();

      await assert.rejects(
        within(command.run, 15_000, 'the stopped command'),
        trigger === 'abort'
          ? { name: 'AbortError' }
          : { message: /^Timed out after 2000 ms: / },
      );

      probesOnly(command.signals());
    } finally {
      await command.close();
    }
  });

test("an abort after the command's exit still kills what stayed in its group", async () => {
  const command = await left('sleep 30 & echo $! > member.pid');

  try {
    const member = command.pid('member')!;
    assert.equal(await running(member), true);
    command.abort();

    await assert.rejects(within(command.run, 15_000, 'the stopped command'), {
      name: 'AbortError',
    });

    assert.ok(command.signals().includes('SIGKILL ok'));
    await until('the member to stop', async () => !(await running(member)));
  } finally {
    await command.close();
  }
});

test("a group that empties after the command's exit is forgotten", async () => {
  const command = await left(
    `mkfifo gate; ${outside()}; (read _ < gate) & echo $! > member.pid`,
  );

  try {
    await until('a probe to find the member', () =>
      command.signals().includes('0 ok'),
    );

    await writeFile(join(command.cwd, 'gate'), 'go\n');

    await until('a probe to find the group empty', () =>
      command.signals().includes('0 ESRCH'),
    );

    command.abort();

    await assert.rejects(within(command.run, 15_000, 'the stopped command'), {
      name: 'AbortError',
    });

    probesOnly(command.signals());
  } finally {
    await command.close();
  }
});

/** the member's parent leaves the group without reaping it, so the group keeps answering after the kill. */
const unreaped = () =>
  outside(
    'my $c = fork; if (!$c) { exec "sleep", "30" } open my $m, ">", "member.pid"; print $m $c; close $m; ',
  );

test('a stopped command returns while its killed member is unreaped', async () => {
  const command = await left(unreaped());

  try {
    const member = command.pid('member')!;
    assert.equal(await running(member), true);
    command.abort();

    await assert.rejects(within(command.run, 15_000, 'the stopped command'), {
      name: 'AbortError',
    });

    assert.equal(await running(member), false);
    assert.equal(await running(command.pid('outside')!), true);
  } finally {
    await command.close();
  }
});

test('a stopped command waits out a slow listing of its group', async () => {
  const command = await left(unreaped());
  let listings = 0;

  // stands in for a full listing that takes 1500 ms, killed at the caller's timeout as `ps` would be
  vi.mocked(ps).mockImplementation(async (format, pids, options) => {
    if (format !== 'pgid=,stat=' || pids || listings++)
      return actual.ps(format, pids, options);

    if (options?.timeout !== undefined && options.timeout < 1500) {
      await delay(options.timeout);

      throw Object.assign(
        new Error(`Command failed: /bin/ps -A -o ${format}`),
        { killed: true, signal: 'SIGKILL' },
      );
    }

    await delay(1500);

    return actual.ps(format, pids, options);
  });

  try {
    const member = command.pid('member')!;
    command.abort();

    await assert.rejects(within(command.run, 15_000, 'the stopped command'), {
      name: 'AbortError',
    });

    assert.equal(listings, 1);
    assert.equal(await running(member), false);
  } finally {
    vi.mocked(ps).mockImplementation(actual.ps);
    await command.close();
  }
});

test('a command stopped while it runs returns though a descendant outside its group holds its pipes', async () => {
  const command = await left(`${outside()}; echo $$ > leader.pid; sleep 30`, {
    exits: false,
  });

  try {
    command.abort();

    await assert.rejects(within(command.run, 15_000, 'the stopped command'), {
      name: 'AbortError',
    });

    assert.ok(command.signals().includes('SIGKILL ok'));
    assert.equal(await running(command.pid('outside')!), true);
  } finally {
    await command.close();
  }
});

test('a stopped command keeps killing a group that outlives the first kill', async () => {
  const command = await left('sleep 30 & echo $! > member.pid', { lost: 1 });

  try {
    command.abort();

    await assert.rejects(within(command.run, 15_000, 'the stopped command'), {
      name: 'AbortError',
    });

    assert.deepEqual(
      command
        .signals()
        .filter((signal) => signal.startsWith('SIGKILL'))
        .slice(0, 2),
      ['SIGKILL lost', 'SIGKILL ok'],
    );
  } finally {
    await command.close();
  }
});
