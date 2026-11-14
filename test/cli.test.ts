import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { compiledCli } from './fixtures/compiled-cli.js';
import { scratch } from './fixtures/scratch.js';
import { ControlHost } from '../src/persistence/control.js';
import { CoordinationStore } from '../src/persistence/coordination.js';
import { StateStore } from '../src/persistence/store.js';
import { identifyProcess } from '../src/persistence/process.js';
import { controlPrefix } from '../src/cli-control.js';
import { quote } from '../src/shell.js';

const identity = (await identifyProcess(process.pid))!;
const repository = fileURLToPath(new URL('../', import.meta.url));
const sourceCli = join(repository, 'src/cli.tsx');

/** runs the CLI in an empty directory that is also its HOME, so a store opened at the default ~/.witch shows in `files`. */
async function run(args: readonly string[] | string, entry?: string) {
  const directory = await scratch('witch-cli-');

  const child = spawn(
    typeof args === 'string' ? '/bin/zsh' : process.execPath,
    typeof args === 'string'
      ? ['-c', args]
      : [
          ...(entry === sourceCli
            ? ['--import', import.meta.resolve('../scripts/register.mjs')]
            : []),
          entry ?? (await compiledCli()),
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
  [['--apply'], /--apply requires --recover-directory/],
  [['--recover-directory', ''], /needs a saved directory/],
  [['--recover-directory', '/old', '--continue'], /cannot include/],
  [['--recover-directory', '/old', 'prompt'], /cannot include/],
  [['--recover-directory', '/old'], /ENOENT/],
  [['hi'], /^witch: Witch needs an interactive terminal\.\n$/],
  [['--spawn', '0'], /--spawn needs a positive number/],
  [['--spawn', 'x'], /--spawn needs a positive number/],
  [['--spawn', '2', '--state-dir', '/s'], /--spawn cannot include/],
  [['--spawn', '2', '--peers'], /--spawn cannot include/],
] as const) {
  test(`witch ${JSON.stringify(args)} exits 1 with a one-line error before opening the store`, async () => {
    const { code, stderr, files } = await run(args);

    assert.equal(code, 1);

    assert.match(stderr, /^witch: /);

    assert.match(stderr, expected);

    assert.doesNotMatch(stderr, /\n\s+at /);

    assert.deepEqual(files, []);
  });
}

test('witch --help with stdout piped prints the usage and exits 0 before opening the store', async () => {
  for (const entry of [sourceCli, await compiledCli()]) {
    const { code, stdout, files } = await run(['--help'], entry);

    assert.equal(code, 0);

    assert.match(stdout, /^Usage: witch /);

    assert.deepEqual(files, []);
  }
});

test("witch --spawn outside a repository exits 1 with git's error, without a terminal", async () => {
  const { code, stdout, stderr, files } = await run(['--spawn', '2']);

  assert.equal(code, 1);

  assert.equal(stdout, '');

  assert.match(stderr, /^witch: [^\n]*not a git repository[^\n]*\n$/);

  assert.deepEqual(files, []);
});

test('witch --recover-directory previews, applies and reports a blocked record without launching an agent', async () => {
  const root = await scratch('witch-cli-recover-');
  const state = join(root, 'state');
  const destination = join(root, 'destination');
  const bin = join(root, 'bin');
  const launched = join(root, 'launched');

  await mkdir(destination);

  await mkdir(bin);

  for (const agent of ['claude', 'codex'])
    await writeFile(join(bin, agent), `#!/bin/sh\ntouch ${quote(launched)}\n`, {
      mode: 0o755,
    });

  const store = await StateStore.open(state);
  const source = join(root, 'gone');

  await (
    await store.create({
      id: 'moved',
      title: 'Moved',
      cwd: source,
      agent: 'claude',
      sessions: {},
      createdAt: new Date().toISOString(),
    })
  ).close();

  const recover = (apply: boolean) =>
    run(
      `cd ${quote(destination)} && PATH=${quote(bin)}:$PATH ${quote(process.execPath)} ${quote(compiled)} --state-dir ${quote(state)} --recover-directory ${quote(source)}${apply ? ' --apply' : ''}`,
    );

  const compiled = await compiledCli();

  const record = async () =>
    (
      JSON.parse(
        await readFile(join(state, 'conversations/moved/state.json'), 'utf8'),
      ) as { cwd: string }
    ).cwd;

  const preview = await recover(false);

  assert.equal(preview.code, 0, preview.stderr);

  assert.match(preview.stdout, /Would repair/);

  assert.match(preview.stdout, /--apply/);

  assert.equal(await record(), source);

  const applied = await recover(true);

  assert.equal(applied.code, 0, applied.stderr);

  assert.equal(await record(), destination);

  // held open, as another Witch would
  const open = await store.create({
    id: 'open',
    title: 'Open',
    cwd: join(root, 'also gone'),
    agent: 'claude',
    sessions: {},
    createdAt: new Date().toISOString(),
  });

  try {
    const blocked = await run(
      `cd ${quote(destination)} && ${quote(process.execPath)} ${quote(compiled)} --state-dir ${quote(state)} --recover-directory ${quote(join(root, 'also gone'))} --apply`,
    );

    assert.equal(blocked.code, 1);

    assert.match(blocked.stdout, /open in another Witch/);
  } finally {
    await open.close();
  }

  await assert.rejects(readFile(launched), { code: 'ENOENT' });
});

test('headless controls preserve quoted paths, JSON, errors and conflicts without normal startup', async () => {
  const root = await scratch('witch-cli-control-');
  const directory = join(root, "owner's control files");
  const binding = { directory, conversation: 'a', activation: randomUUID() };
  const store = await CoordinationStore.open(await StateStore.open(root));

  const occupied = await store.claim(
    { conversation: 'b', project: 'project-p' },
    { reference: 'task:occupied', summary: 'Other work' },
    identity,
    Date.now() + 5000,
    async () => {},
  );

  const failures: unknown[] = [];

  const selection = {
    ticket: {
      owner: { conversation: 'a', project: 'project-p' },
      activation: binding.activation,
      turn: randomUUID(),
      id: randomUUID(),
    },
    position: 1,
  };

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
            ownSelection: selection,
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

  const prefix = controlPrefix(binding, sourceCli);

  try {
    const query = await run(`${prefix} --peers --json`);

    assert.equal(query.code, 0);

    assert.equal(query.stderr, '');

    assert.deepEqual(JSON.parse(query.stdout).snapshot.reservations, [
      { claim: occupied, status: 'unattended' },
    ]);

    assert.deepEqual(query.files, []);

    for (const [position, status] of [
      [1, 'choosing'],
      [3, 'queued #3'],
    ] as const) {
      selection.position = position;
      const text = await run(`${prefix} --peers`);

      assert.equal(text.code, 0);

      assert.equal(text.stderr, '');

      assert.equal(
        text.stdout.split('\n')[0],
        `Selection ${selection.ticket.id}: ${status}`,
      );
    }

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

test('claim warnings survive the control transport in JSON and plain output without failing local ownership', async () => {
  const root = await scratch('witch-cli-assignment-');

  const binding = {
    directory: join(root, 'control'),
    conversation: 'a',
    activation: randomUUID(),
  };

  const registry = await CoordinationStore.open(await StateStore.open(root));
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
    const command = `${controlPrefix(binding, await compiledCli())} --claim https://github.com/acme/widget/issues/42 --summary 'Current work'`;
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

test('an unavailable control host reports JSON failure without opening state', async () => {
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

// agents run control commands constantly, and loading the app triples their startup
test('a control command starts without loading the app', async () => {
  const root = await scratch('witch-cli-loads-');
  const hook = join(root, 'record-loads.mjs');
  const loaded = join(root, 'loaded');

  await writeFile(
    hook,
    `import { appendFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
registerHooks({
  load(url, context, next) {
    appendFileSync(${JSON.stringify(loaded)}, url + '\\n');
    return next(url, context);
  },
});
`,
  );

  const child = spawn(
    process.execPath,
    [
      '--import',
      hook,
      await compiledCli(),
      '--control-dir',
      join(root, 'missing'),
      '--control-conversation',
      'a',
      '--control-activation',
      randomUUID(),
      '--peers',
      '--json',
    ],
    { stdio: 'ignore' },
  );

  const [code] = await once(child, 'close');

  assert.equal(code, 1);

  const urls = (await readFile(loaded, 'utf8')).split('\n');

  assert.ok(urls.some((url) => url.endsWith('/dist/cli-control.js')));

  assert.deepEqual(
    urls.filter(
      (url) =>
        url.endsWith('/dist/witch.js') || url.includes('/node_modules/ink/'),
    ),
    [],
  );
});

for (const extra of [
  ['--claim', 'task:extra', '--summary', 'Extra'],
  ['prompt'],
  ['--state-dir', '/unused'],
  ['--continue'],
  ['--summary', 'Extra'],
]) {
  test(`headless controls reject ${JSON.stringify(extra)} before startup`, async () => {
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

test('witch sessions remains a positional prompt', async () => {
  const result = await run(['sessions']);

  assert.equal(result.code, 1);

  assert.match(result.stderr, /interactive terminal/);

  assert.deepEqual(result.files, []);
});
