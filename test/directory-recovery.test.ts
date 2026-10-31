import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import type { ExecFileException } from 'node:child_process';
import { once } from 'node:events';
import {
  access,
  appendFile,
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { recoverDirectory } from '../src/persistence/directory-recovery.js';
import { StateStore } from '../src/persistence/store.js';
import { identifyProcess } from '../src/persistence/process.js';
import { Memory } from '../src/memory/memory.js';
import { quote } from '../src/shell.js';
import { compiledCli } from './fixtures/compiled-cli.js';
import { scratch } from './fixtures/scratch.js';
import { within } from './fixtures/within.js';

const execute = promisify(execFile);
const storeModule = fileURLToPath(
  new URL('../src/persistence/store.ts', import.meta.url),
);

async function fixture() {
  const root = await scratch('witch-directory-recovery-');
  const source = join(root, "owner's old directory");
  const destination = join(root, 'new directory');
  const unrelated = join(root, 'unrelated');
  for (const path of [destination, unrelated]) await mkdir(path);
  const store = await StateStore.open(join(root, 'state'));
  const memory = new Memory(join(store.root, 'memory.git'));
  const project = (await memory.scopePaths(destination)).project;
  const directory = (id: string) => join(store.root, 'conversations', id);
  const state = (id: string) => join(directory(id), 'state.json');
  const history = (id: string) => join(directory(id), 'history.jsonl');
  for (const [id, cwd, date] of [
    ['a', source, '2020-01-01'],
    ['b', source, '2020-01-03'],
    ['c', destination, '2020-01-02'],
    ['d', unrelated, '2020-01-04'],
  ] as const) {
    const files = await store.create({
      id,
      title: `Title ${id}`,
      cwd,
      agent: 'codex',
      createdAt: `${date}T00:00:00Z`,
      sessions: {
        codex: {
          id: `native-${id}`,
          model: `model-${id}`,
          hasHistory: true,
          effort: 'high',
          deliveredProject: project,
        },
      },
    });
    await files.append({
      id: `message-${id}`,
      kind: 'user',
      text: `kept-${id}`,
      cwd: join(cwd, 'sub'),
    });
    await files.close();
    await utimes(history(id), new Date(date), new Date(date));
  }
  for (const [cwd, text] of [
    [source, 'old-first'],
    [destination, 'new-first'],
    [unrelated, 'other'],
    [source, 'old-last'],
  ])
    await store.addPrompt(cwd!, text!);
  const original = JSON.parse(await readFile(state('a'), 'utf8')) as Record<
    string,
    unknown
  >;
  await writeFile(
    state('a'),
    JSON.stringify({ ...original, futureField: 'kept' }),
  );
  const data = async () =>
    Promise.all(
      [
        ...['a', 'b', 'c', 'd'].flatMap((id) => [state(id), history(id)]),
        join(store.root, 'prompts.jsonl'),
      ].map((path) => readFile(path)),
    );
  const recover = (apply = true) =>
    recoverDirectory(store, memory, source, destination, apply);
  const bin = join(root, 'bin');
  await mkdir(bin);
  await symlink(
    (await execute('/usr/bin/which', ['git'])).stdout.trim(),
    join(bin, 'git'),
  );
  const launched = join(root, 'native-launched');
  for (const name of ['codex', 'claude'])
    await writeFile(
      join(bin, name),
      `#!/bin/sh\nprintf started >> ${quote(launched)}\nexit 1\n`,
      { mode: 0o755 },
    );
  const tty = join(root, 'tty.mjs');
  await writeFile(
    tty,
    "Object.defineProperty(process.stdin, 'isTTY', { value: true }); Object.defineProperty(process.stdout, 'isTTY', { value: true });\n",
  );
  const cli = async (args: string[] = [], normal = false) => {
    const entry = await compiledCli();
    try {
      const output = await execute(
        process.execPath,
        [
          ...(normal ? ['--import', tty] : []),
          entry,
          '--state-dir',
          store.root,
          ...(normal ? ['-c'] : ['--recover-directory', source]),
          ...args,
        ],
        {
          cwd: destination,
          env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
          timeout: 20_000,
        },
      );
      return { ...output, code: 0 };
    } catch (error) {
      const failed = error as ExecFileException & {
        stdout: string;
        stderr: string;
      };
      if (typeof failed.code !== 'number') throw error;
      return {
        code: failed.code,
        stdout: failed.stdout,
        stderr: failed.stderr,
      };
    }
  };
  return {
    root,
    source,
    destination,
    unrelated,
    store,
    memory,
    project,
    directory,
    state,
    history,
    data,
    recover,
    cli,
    launched,
  };
}

test('directory recovery preserves the selected group and history order', async () => {
  const f = await fixture();
  const before = await f.data();
  const preview = await f.cli();
  assert.equal(preview.code, 0, preview.stderr);
  assert.match(preview.stdout, /Conversations: 2/);
  assert.match(preview.stdout, /Histories: 2/);
  assert.match(preview.stdout, /Prompts: 2/);
  assert.deepEqual(await f.data(), before);
  await assert.rejects(access(join(f.store.root, 'directory-recovery.lock')), {
    code: 'ENOENT',
  });
  await assert.rejects(access(join(f.store.root, 'recoveries')), {
    code: 'ENOENT',
  });
  const result = await f.recover();
  assert.equal(result.applied, true);
  assert.equal(result.conversations, 2);
  assert.equal(result.histories, 2);
  assert.equal(result.prompts, 2);
  const reopened = await StateStore.open(f.store.root);
  assert.deepEqual(await reopened.prompts(f.destination), [
    'old-last',
    'new-first',
    'old-first',
  ]);
  assert.deepEqual(await reopened.prompts(f.unrelated), ['other']);
  assert.deepEqual(
    (await reopened.conversations(f.destination)).map(({ id }) => id),
    ['b', 'c', 'a'],
  );
  assert.deepEqual(await reopened.conversations(f.source), []);
  const record = JSON.parse(await readFile(f.state('a'), 'utf8')) as Record<
    string,
    unknown
  >;
  assert.equal(record.cwd, f.destination);
  assert.equal(record.futureField, 'kept');
  assert.deepEqual(record.sessions, {
    codex: {
      id: 'native-a',
      model: 'model-a',
      hasHistory: true,
      effort: 'high',
      deliveredProject: f.project,
    },
  });
  const held = await reopened.claim('a');
  try {
    assert.deepEqual(
      (await held.items()).map(({ text, cwd }) => ({ text, cwd })),
      [{ text: 'kept-a', cwd: join(f.destination, 'sub') }],
    );
  } finally {
    await held.close();
  }
  assert.deepEqual((await f.data()).slice(4, 8), before.slice(4, 8));
  const originals = await Promise.all(
    (await readdir(result.backup!))
      .filter((name) => name.endsWith('.original'))
      .map((name) => readFile(join(result.backup!, name))),
  );
  for (const index of [0, 1, 2, 3, 8])
    assert.ok(originals.some((content) => content.equals(before[index]!)));
  await assert.rejects(access(join(f.store.root, 'directory-recovery.json')), {
    code: 'ENOENT',
  });
  assert.equal((await f.recover()).applied, true);
  assert.deepEqual(await reopened.prompts(f.destination), [
    'old-last',
    'new-first',
    'old-first',
  ]);
  assert.equal((await readdir(join(f.store.root, 'recoveries'))).length, 1);
  await assert.rejects(access(f.launched), { code: 'ENOENT' });
});

test('recovery preserves duplicate prompts, unreadable lines and unrelated link bases', async () => {
  const f = await fixture();
  await f.store.addPrompt(f.source, 'old-first');
  const torn = Buffer.from('\n{"cwd":"unfinished');
  await appendFile(join(f.store.root, 'prompts.jsonl'), torn);
  const outside = JSON.stringify({
    id: 'outside',
    kind: 'notice',
    text: 'other',
    cwd: f.unrelated,
  });
  const prefix = JSON.stringify({
    id: 'prefix',
    kind: 'notice',
    text: 'prefix',
    cwd: `${f.source}-other`,
  });
  const bytes = Buffer.concat([
    Buffer.from(`\n${outside}\r\n${prefix}\nnot json\n`),
    Buffer.from([0xff, 10]),
  ]);
  await appendFile(f.history('a'), bytes);
  const result = await f.recover();
  assert.equal(result.prompts, 3);
  assert.deepEqual(await f.store.prompts(f.destination), [
    'old-first',
    'old-last',
    'new-first',
    'old-first',
  ]);
  assert.ok(
    (await readFile(join(f.store.root, 'prompts.jsonl')))
      .subarray(-torn.length)
      .equals(torn),
  );
  assert.ok(
    (await readFile(f.history('a'))).subarray(-bytes.length).equals(bytes),
  );
});

test('an open legacy conversation blocks apply without changing its data', async () => {
  const f = await fixture();
  const before = await f.data();
  const held = await f.store.claim('d');
  try {
    const result = await f.cli(['--apply']);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /conversation\(s\) are open/);
    assert.equal(held.closed, false);
    assert.deepEqual(await f.data(), before);
    await assert.rejects(access(join(f.store.root, 'recoveries')), {
      code: 'ENOENT',
    });
  } finally {
    await held.close();
  }
});

test('a relative recovery source changes no saved data', async () => {
  const f = await fixture();
  const before = await f.data();
  await assert.rejects(
    recoverDirectory(f.store, f.memory, 'relative', f.destination, true),
    /absolute saved directory/,
  );
  assert.deepEqual(await f.data(), before);
  await assert.rejects(access(join(f.store.root, 'recoveries')), {
    code: 'ENOENT',
  });
});

test('a reused PID with a different start time does not block recovery', async () => {
  const f = await fixture();
  const record = JSON.parse(await readFile(f.state('a'), 'utf8')) as Record<
    string,
    unknown
  >;
  const previous = { pid: process.pid, started: 'Thu Jan  1 00:00:00 1970' };
  await writeFile(
    f.state('a'),
    JSON.stringify({ ...record, process: previous }),
  );
  const result = await f.recover();
  assert.equal(result.applied, true, result.blockers.join('\n'));
  assert.deepEqual(
    (JSON.parse(await readFile(f.state('a'), 'utf8')) as { process: unknown })
      .process,
    previous,
  );
});

test('pending recovery rejects a changed destination scope even without saved scope markers', async () => {
  const f = await fixture();
  for (const id of ['a', 'b']) {
    const record = JSON.parse(await readFile(f.state(id), 'utf8')) as {
      sessions: { codex: { deliveredProject?: string } };
    };
    delete record.sessions.codex.deliveredProject;
    await writeFile(f.state(id), JSON.stringify(record));
  }
  await chmod(f.directory('b'), 0o500);
  try {
    await assert.rejects(f.recover(), /EACCES|EPERM/);
  } finally {
    await chmod(f.directory('b'), 0o700);
  }
  await execute('git', ['init', '-b', 'main'], { cwd: f.destination });
  await execute(
    'git',
    [
      'remote',
      'add',
      'origin',
      'https://example.invalid/changed-destination.git',
    ],
    { cwd: f.destination },
  );
  const before = await f.data();
  await assert.rejects(f.recover(), /destination memory scope changed/);
  assert.deepEqual(await f.data(), before);
});

for (const field of [
  'process',
  'usageProcess',
  'answerProcess',
  'shell',
] as const) {
  test(`a live saved ${field} blocks recovery without stopping it`, async () => {
    const f = await fixture();
    const child = spawn('/bin/sleep', ['30']);
    const closed = once(child, 'close');
    try {
      const record = JSON.parse(await readFile(f.state('a'), 'utf8')) as Record<
        string,
        unknown
      >;
      await writeFile(
        f.state('a'),
        JSON.stringify({
          ...record,
          [field]: await identifyProcess(child.pid!),
        }),
      );
      const before = await f.data();
      const result = await f.recover();
      assert.equal(result.applied, false);
      assert.match(
        result.blockers.join('\n'),
        /process or shell is still running/,
      );
      assert.equal(child.exitCode, null);
      assert.deepEqual(await f.data(), before);
    } finally {
      child.kill();
      await within(closed, 3000, 'the saved process exit');
    }
  });
}

for (const blocked of [
  'existing source',
  'different project',
  'unreadable record',
]) {
  test(`${blocked} blocks recovery before any backup or data replacement`, async () => {
    const f = await fixture();
    if (blocked === 'existing source') await mkdir(f.source);
    else if (blocked === 'unreadable record')
      await writeFile(f.state('b'), 'torn state');
    else {
      const record = JSON.parse(await readFile(f.state('a'), 'utf8')) as {
        sessions: { codex: { deliveredProject: string } };
      };
      record.sessions.codex.deliveredProject = 'projects/different';
      await writeFile(f.state('a'), JSON.stringify(record));
    }
    const before = await f.data();
    const result = await f.recover();
    assert.equal(result.applied, false);
    assert.ok(result.blockers.length);
    assert.deepEqual(await f.data(), before);
    await assert.rejects(access(join(f.store.root, 'recoveries')), {
      code: 'ENOENT',
    });
  });
}

for (const outsideEdit of [false, true]) {
  test(`a failed apply ${outsideEdit ? 'refuses an outside edit' : 'resumes in a new process'}`, async () => {
    const f = await fixture();
    await chmod(f.directory('b'), 0o500);
    try {
      const failed = await f.cli(['--apply']);
      assert.equal(failed.code, 1, failed.stdout + failed.stderr);
      assert.equal(
        (JSON.parse(await readFile(f.state('a'), 'utf8')) as { cwd: string })
          .cwd,
        f.destination,
      );
      const normal = await f.cli([], true);
      assert.equal(normal.code, 1, normal.stderr);
      assert.match(normal.stderr, /Directory recovery is incomplete/);
      assert.match(normal.stderr, /--apply/);
      await assert.rejects(access(f.launched), { code: 'ENOENT' });
    } finally {
      await chmod(f.directory('b'), 0o700);
    }
    if (outsideEdit) {
      const record = JSON.parse(await readFile(f.state('a'), 'utf8')) as Record<
        string,
        unknown
      >;
      const edited = JSON.stringify({ ...record, title: 'outside edit' });
      await writeFile(f.state('a'), edited);
      const retry = await f.cli(['--apply']);
      assert.equal(retry.code, 1);
      assert.match(retry.stderr, /changed outside the migration/);
      assert.equal(await readFile(f.state('a'), 'utf8'), edited);
      assert.equal(
        (JSON.parse(await readFile(f.state('b'), 'utf8')) as { cwd: string })
          .cwd,
        f.source,
      );
    } else {
      await mkdir(f.source);
      const changed = await f.cli(['--apply']);
      assert.equal(changed.code, 1);
      assert.match(changed.stderr, /source directory still exists/);
      await rename(f.source, join(f.root, 'reappeared'));
      const retry = await f.cli(['--apply']);
      assert.equal(retry.code, 0, retry.stderr);
      assert.match(retry.stdout, /Conversations: 2/);
      assert.deepEqual(await f.store.prompts(f.destination), [
        'old-last',
        'new-first',
        'old-first',
      ]);
      assert.deepEqual(
        (await f.store.conversations(f.destination)).map(({ id }) => id),
        ['b', 'c', 'a'],
      );
      assert.equal((await f.cli(['--apply'])).code, 0);
      assert.deepEqual(await f.store.prompts(f.destination), [
        'old-last',
        'new-first',
        'old-first',
      ]);
    }
  });
}

test('state locks allow readers together and exclude recovery across processes', async () => {
  const f = await fixture();
  const attempt = (mode: 'shared' | 'exclusive') =>
    execute(process.execPath, [
      '--import',
      import.meta.resolve('tsx'),
      '--input-type=module',
      '-e',
      `import { StateStore } from ${JSON.stringify(storeModule)}; const store = await StateStore.open(${JSON.stringify(f.store.root)}); const lock = await store.lockDirectory(${JSON.stringify(mode)}); await lock.close();`,
    ]);
  const shared = await f.store.lockDirectory('shared');
  try {
    await attempt('shared');
    await assert.rejects(
      attempt('exclusive'),
      /Another session or recovery is running/,
    );
  } finally {
    await shared.close();
  }
  const exclusive = await f.store.lockDirectory('exclusive');
  try {
    await assert.rejects(
      attempt('shared'),
      /Another session or recovery is running/,
    );
    const blocked = await f.cli([], true);
    assert.equal(blocked.code, 1);
    assert.match(blocked.stderr, /Another session or recovery is running/);
    await assert.rejects(access(f.launched), { code: 'ENOENT' });
  } finally {
    await exclusive.close();
  }
  await attempt('exclusive');
});

test('a killed state-lock owner releases recovery admission', async () => {
  const root = await scratch('witch-state-lock-');
  const store = await StateStore.open(root);
  const child = spawn(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      '--input-type=module',
      '-e',
      `import { StateStore } from ${JSON.stringify(storeModule)}; const store = await StateStore.open(${JSON.stringify(root)}); const lock = await store.lockDirectory('exclusive'); process.stdin.once('end', () => void lock.close()); process.stdout.write('ready'); process.stdin.resume();`,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const closed = once(child, 'close');
  try {
    await within(once(child.stdout, 'data'), 5000, 'the lock owner');
    await assert.rejects(
      store.lockDirectory('exclusive'),
      /Another session or recovery is running/,
    );
  } finally {
    child.kill('SIGKILL');
    await within(closed, 3000, 'the lock owner exit');
  }
  await (await store.lockDirectory('exclusive')).close();
  assert.ok((await stat(join(root, 'directory-recovery.lock'))).isFile());
});
