import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCommand } from '../src/core/command.js';
import { scratch } from './fixtures/scratch.js';

await test('commands preserve cwd, arguments and environment in returned output', async () => {
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
    },
  );
  assert.deepEqual(JSON.parse(result.stdout), {
    cwd: directory,
    args: ['first', 'second'],
    gitTerminalPrompt: '0',
  });
});

await test('native timeout failures retain their output and metadata', async () => {
  const cwd = await scratch('witch-command-');
  await assert.rejects(
    runCommand(
      process.execPath,
      [
        '-e',
        "process.stdout.write('stdout marker'); process.stderr.write('stderr marker'); setTimeout(() => process.exit(29), 10000)",
      ],
      { cwd, timeout: 1500 },
    ),
    {
      message: /^Timed out after 1500 ms: Command failed:/,
      killed: true,
      code: null,
      signal: 'SIGTERM',
      stdout: 'stdout marker',
      stderr: 'stderr marker',
    },
  );
});

await test('timeout failures remain labeled when the child handles SIGTERM', async () => {
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

await test('other command failures keep their native diagnostics', async () => {
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
      runCommand(command, ['-e', script], { cwd, timeout: 5000 }),
      { message: /^(?!Timed out after )/, ...fields },
    );
  }
});
