import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { scratch } from './fixtures/scratch.js';
import { ControlHost } from '../src/persistence/control.js';
import { CoordinationStore } from '../src/persistence/coordination.js';
import { identifyProcess } from '../src/persistence/process.js';
import { controlPrefix } from '../src/cli-control.js';

const identity = (await identifyProcess(process.pid))!;

const cli = fileURLToPath(new URL('../src/cli.tsx', import.meta.url));

/** runs the CLI in an empty directory that is also its HOME, so a store opened at the default ~/.witch shows in `files`. */
async function run(args: readonly string[] | string) {
  const directory = await scratch('witch-cli-');
  const child = spawn(
    typeof args === 'string' ? '/bin/zsh' : process.execPath,
    typeof args === 'string'
      ? ['-c', args]
      : [
          '--import',
          import.meta.resolve('../scripts/register.mjs'),
          cli,
          ...args,
        ],
    {
      cwd: directory,
      env: { ...process.env, HOME: directory },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const [code] = await once(child, 'close');
  for (const output of [stdout, stderr])
    for (const marker of ['\u001b]2;', '\u001b]777;', '\u0007'])
      assert.equal(output.includes(marker), false);
  return { code, stdout, stderr, files: await readdir(directory) };
}

for (const [args, expected] of [
  [['--state-dir'], /--state-dir/],
  [['--state-dir', ''], /--state-dir/],
  [['--state-dir', '--continue'], /--state-dir/],
  [['-v'], /^witch: Unknown option '-v'/],
  [['hi'], /^witch: Witch needs an interactive terminal\.\n$/],
] as const) {
  await test(`witch ${JSON.stringify(args)} exits 1 with a one-line error before opening the store`, async () => {
    const { code, stderr, files } = await run(args);
    assert.equal(code, 1);
    assert.match(stderr, /^witch: /);
    assert.match(stderr, expected);
    assert.doesNotMatch(stderr, /\n\s+at /);
    assert.deepEqual(files, []);
  });
}

await test('witch --help with stdout piped prints the usage and exits 0 before opening the store', async () => {
  const { code, stdout, files } = await run(['--help']);
  assert.equal(code, 0);
  assert.match(stdout, /^Usage: witch /);
  assert.deepEqual(files, []);
});

await test('headless controls preserve quoted paths, JSON, errors and conflicts without normal startup', async () => {
  const root = await scratch('witch-cli-control-');
  const directory = join(root, "owner's control files");
  const binding = { directory, conversation: 'a', activation: randomUUID() };
  const store = await CoordinationStore.open(root);
  const occupied = await store.claim(
    { conversation: 'b', project: 'project-p' },
    { reference: 'task:occupied', summary: 'Other work' },
    identity,
    Date.now() + 5000,
    async () => {},
  );
  const failures: unknown[] = [];
  const host = await ControlHost.open(
    directory,
    async ({ action, conversation, deadline }) => {
      if (action.kind === 'peers')
        return {
          kind: 'peers',
          snapshot: {
            peers: [],
            reservations: [{ claim: occupied, status: 'unattended' }],
            unregistered: [],
          },
        };
      if (action.kind === 'release') {
        await store.release(
          { conversation, project: 'project-p' },
          action.claim,
          deadline,
          async () => {},
        );
        return { kind: 'released' };
      }
      if (action.kind !== 'claim') throw new Error('Unexpected test action');
      return {
        kind: 'claimed',
        claim: await store.claim(
          { conversation, project: 'project-p' },
          action.input,
          identity,
          deadline,
          async () => {},
        ),
      };
    },
    (error) => failures.push(error),
  );
  const prefix = controlPrefix(binding, cli);
  try {
    const query = await run(`${prefix} --peers --json`);
    assert.equal(query.code, 0);
    assert.equal(query.stderr, '');
    assert.deepEqual(JSON.parse(query.stdout).snapshot.reservations, [
      { claim: occupied, status: 'unattended' },
    ]);
    assert.deepEqual(query.files, []);
    const conflict = await run(
      `${prefix} --claim task:occupied --summary 'Duplicate' --json`,
    );
    assert.equal(conflict.code, 2);
    assert.equal(conflict.stderr, '');
    assert.equal(JSON.parse(conflict.stdout).claim.id, occupied.id);
    assert.deepEqual(conflict.files, []);
    const own = await run(
      `${prefix} --claim task:ours --summary 'Current work' --alias https://github.com/acme/widget/issues/42 --alias task:related --json`,
    );
    assert.equal(own.code, 0);
    const claim = JSON.parse(own.stdout).claim;
    assert.equal(claim.owner.conversation, 'a');
    assert.deepEqual(claim.references, [
      'task:project-p:ours',
      'github:acme/widget#42',
      'task:project-p:related',
    ]);
    assert.deepEqual(await store.claims(), [occupied, claim]);
    assert.deepEqual(own.files, []);
    const message = 'Use a full GitHub issue or pr URL, or task:<name>.';
    for (const [args, json] of [
      ['--claim 155', true],
      ["--claim 'https://github.com/acme/queue/issues/%'", false],
      ["--claim task:ours --alias 'issue 155'", true],
    ] as const) {
      const result = await run(
        `${prefix} ${args} --summary 'Rejected update'${json ? ' --json' : ''}`,
      );
      assert.equal(result.code, 1);
      if (json) {
        const error = JSON.parse(result.stdout);
        assert.equal(error.kind, 'error');
        assert.equal(error.message, message);
        assert.equal(result.stderr, '');
      } else {
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, `${message}\n`);
      }
      assert.deepEqual(await store.claims(), [occupied, claim]);
      assert.deepEqual(result.files, []);
    }
    const released = await run(`${prefix} --release ${claim.id} --json`);
    assert.equal(released.code, 0);
    assert.equal(released.stderr, '');
    assert.equal(JSON.parse(released.stdout).kind, 'released');
    assert.deepEqual(await store.claims(), [occupied]);
    assert.deepEqual(released.files, []);
    assert.deepEqual(failures, []);
  } finally {
    await host.close();
  }
});

await test('claim warnings survive the control transport in JSON and plain output without failing local ownership', async () => {
  const root = await scratch('witch-cli-assignment-');
  const binding = {
    directory: join(root, 'control'),
    conversation: 'a',
    activation: randomUUID(),
  };
  const registry = await CoordinationStore.open(root);
  const failures: unknown[] = [];
  const warning = 'GitHub assignment failed: permission denied';
  const host = await ControlHost.open(
    binding.directory,
    async ({ action, deadline }) => {
      if (action.kind !== 'claim') throw new Error('Unexpected test action');
      return {
        kind: 'claimed',
        claim: await registry.claim(
          { conversation: 'a', project: 'project-p' },
          action.input,
          identity,
          deadline,
          async () => {},
        ),
        warning,
      };
    },
    (error) => failures.push(error),
  );
  try {
    const command = `${controlPrefix(binding, cli)} --claim https://github.com/acme/widget/issues/42 --summary 'Current work'`;
    const json = await run(`${command} --json`);
    assert.equal(json.code, 0);
    assert.equal(json.stderr, '');
    assert.equal(JSON.parse(json.stdout).warning, warning);
    assert.deepEqual(await registry.claims(), [JSON.parse(json.stdout).claim]);
    const plain = await run(command);
    assert.equal(plain.code, 0);
    assert.equal(plain.stderr, '');
    assert.match(plain.stdout, /Claimed: Current work/);
    assert.ok(plain.stdout.includes(`Warning: ${warning}`));
    assert.equal((await registry.claims()).length, 1);
    assert.deepEqual(failures, []);
  } finally {
    await host.close();
  }
});

await test('an unavailable control host reports JSON failure without opening state', async () => {
  const root = await scratch('witch-cli-unavailable-');
  const result = await run([
    '--control-dir',
    join(root, 'missing'),
    '--control-conversation',
    'a',
    '--control-activation',
    randomUUID(),
    '--peers',
    '--json',
  ]);
  assert.equal(result.code, 1);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).kind, 'error');
  assert.match(JSON.parse(result.stdout).message, /unavailable/);
  assert.deepEqual(result.files, []);
});

for (const extra of [
  ['--claim', 'task:extra', '--summary', 'Extra'],
  ['prompt'],
  ['--state-dir', '/unused'],
  ['--continue'],
  ['--summary', 'Extra'],
]) {
  await test(`headless controls reject ${JSON.stringify(extra)} before startup`, async () => {
    const result = await run([
      '--control-dir',
      '/unused',
      '--control-conversation',
      'a',
      '--control-activation',
      randomUUID(),
      '--peers',
      '--json',
      ...extra,
    ]);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout).kind, 'error');
    assert.deepEqual(result.files, []);
  });
}

await test('witch sessions remains a positional prompt', async () => {
  const result = await run(['sessions']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /interactive terminal/);
  assert.deepEqual(result.files, []);
});
