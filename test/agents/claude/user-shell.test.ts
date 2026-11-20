import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { bashRecord, runShell } from '../../../src/agents/claude/user-shell.js';
import { scratch } from '../../fixtures/scratch.js';
import { until, within } from '../../fixtures/within.js';

const execute = promisify(execFile);

/** pgrep exits 1 when nothing matches. */
const running = (pattern: string) =>
  execute('pgrep', ['-f', pattern]).then(
    () => true,
    () => false,
  );

const stop = (pattern: string) =>
  execute('pkill', ['-f', pattern]).catch(() => {});

function run(
  command: string,
  cwd: string,
  signal = new AbortController().signal,
) {
  const chunks: string[] = [];

  const result = runShell(command, {
    cwd,
    signal,
    onOutput: (text) => chunks.push(text),
  });

  return { chunks, result };
}

test("a command runs in its directory through the user's shell without a login or stdin and returns its merged output and exit code", async () => {
  const cwd = await scratch('witch-shell-');

  // an open stdin would leave `cat` waiting, and `ps` isn't the last command, so the shell doesn't exec it
  const { result } = run(
    'cat; pwd -P; echo out; echo err >&2; ps -o args= -p $$; exit 3',
    cwd,
  );

  const shell = await within(result, 3000, 'the command');
  const lines = shell.output.split('\n');
  assert.ok(lines.includes(await realpath(cwd)));
  assert.ok(lines.includes('out'));
  assert.ok(lines.includes('err'));

  assert.ok(
    lines.some((line) =>
      line.startsWith(`${process.env.SHELL || '/bin/zsh'} -c `),
    ),
    shell.output,
  );

  assert.equal(shell.code, 3);
  assert.equal(shell.interrupted, false);
});

test("an abort kills the command's whole process group and reports it interrupted", async () => {
  const cwd = await scratch('witch-shell-');

  try {
    // a child forked as the first kill lands is missed now and then, so five runs catch a runner without the second
    for (let attempt = 0; attempt < 5; attempt++) {
      const controller = new AbortController();

      const shell = await within(
        runShell('echo started; sleep 60.137 & sleep 60.138; echo after', {
          cwd,
          signal: controller.signal,
          onOutput: (text) => {
            if (text.includes('started')) controller.abort();
          },
        }),
        3000,
        'the aborted command',
      );

      assert.equal(shell.interrupted, true);
      assert.doesNotMatch(shell.output, /after/);
    }

    await until(
      'the sleeps end',
      async () => !(await running('sleep 60.13[78]')),
    );
  } finally {
    await stop('sleep 60.13[78]');
  }
});

test('a command whose background child holds its output ends when the shell exits and forwards nothing after', async () => {
  const cwd = await scratch('witch-shell-');
  const { chunks, result } = run('echo parent; (sleep 0.3; echo late) &', cwd);
  const shell = await within(result, 2000, 'the command');
  assert.match(shell.output, /parent\n$/);
  assert.equal(shell.code, 0);
  await delay(600);
  assert.doesNotMatch(chunks.join(''), /late/);
});

test("a background child holding a command's output doesn't keep the process alive", async () => {
  const cwd = await scratch('witch-shell-');
  const script = join(cwd, 'quit.mts');

  await writeFile(
    script,
    `import { runShell } from ${JSON.stringify(new URL('../../../src/agents/claude/user-shell.ts', import.meta.url).href)};
await runShell('echo parent; (sleep 2.517; echo late) &', { cwd: process.cwd(), signal: new AbortController().signal, onOutput() {} });
console.log('settled');
`,
  );

  try {
    const child = spawn(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), script],
      {
        cwd,
        env: { ...process.env, NODE_TEST_CONTEXT: undefined },
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    );

    const exited = new Promise<number | null>((resolve) =>
      child.once('exit', resolve),
    );

    // timed from the run settling, so the loader's startup under a loaded runner doesn't count
    await within(
      new Promise<void>((resolve) =>
        child.stdout.on('data', (data: Buffer) => {
          if (data.toString().includes('settled')) resolve();
        }),
      ),
      10000,
      'the run settling',
    );

    assert.equal(await within(exited, 1500, 'the process exiting'), 0);
  } finally {
    await stop('sleep 2.517');
  }
});

test('output past 1 MiB is cut once with a note, and the command still runs to its end', async () => {
  const cwd = await scratch('witch-shell-');
  // a runner that stopped reading would leave `tr` blocked on a full pipe
  const { chunks, result } = run("head -c 2000000 /dev/zero | tr '\\0' a", cwd);
  const shell = await within(result, 5000, 'the command');
  const note = '\n[output past 1 MiB cut]\n';
  assert.equal(shell.output.length, (1 << 20) + note.length);
  assert.ok(shell.output.endsWith(note));
  assert.equal(shell.code, 0);
  assert.equal(chunks.join(''), shell.output);
});

test('the record escapes output, keeps the command as typed, puts any other end in stderr with its note, and cuts long output in the middle', () => {
  assert.equal(
    bashRecord('cat <a> && x', {
      output: 'x<y>&z\n',
      code: 0,
      interrupted: false,
    }),
    '<bash-input>cat <a> && x</bash-input>\n<bash-stdout>x&lt;y&gt;&amp;z\n</bash-stdout><bash-stderr></bash-stderr>',
  );

  assert.equal(
    bashRecord('false', { output: 'no\n', code: 1, interrupted: false }),
    '<bash-input>false</bash-input>\n<bash-stdout></bash-stdout><bash-stderr>no\nExit code 1</bash-stderr>',
  );

  assert.equal(
    bashRecord('sleep 9', { output: 'part', code: null, interrupted: true }),
    '<bash-input>sleep 9</bash-input>\n<bash-stdout></bash-stdout><bash-stderr>part\n[Request interrupted by user]</bash-stderr>',
  );

  assert.equal(
    bashRecord('x', { output: '', code: null, interrupted: false }),
    '<bash-input>x</bash-input>\n<bash-stdout></bash-stdout><bash-stderr>Exit code unknown</bash-stderr>',
  );

  assert.equal(
    bashRecord('x', { output: 'ok\n', code: 0, interrupted: true }),
    '<bash-input>x</bash-input>\n<bash-stdout></bash-stdout><bash-stderr>ok\n[Request interrupted by user]</bash-stderr>',
  );

  const long = 'a'.repeat(15000) + 'b'.repeat(10000) + 'c'.repeat(15000);

  assert.equal(
    bashRecord('x', { output: long, code: 0, interrupted: false }),
    `<bash-input>x</bash-input>\n<bash-stdout>${'a'.repeat(15000)}\n[10000 characters cut]\n${'c'.repeat(15000)}</bash-stdout><bash-stderr></bash-stderr>`,
  );
});
