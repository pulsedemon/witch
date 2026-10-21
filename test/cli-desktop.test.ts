import assert from 'node:assert/strict';
import stripAnsi from 'strip-ansi';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { scratch } from './fixtures/scratch.js';
import { until, within } from './fixtures/within.js';
import { StateStore } from '../src/persistence/store.js';
import { Screen } from '../src/ui/screen.js';

interface DesktopEvent {
  file?: string;
  args?: string[];
  text?: string;
  failed?: boolean;
  configured?: string;
}

await test('the CLI opens the pressed link, copies selected text and reports desktop failures', async () => {
  const repository = fileURLToPath(new URL('../', import.meta.url));
  const root = await scratch('witch-cli-desktop-');
  const project = join(root, 'project');
  const bin = join(root, 'bin');
  await mkdir(project, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, 'codex'),
    `#!/bin/sh\nexec '${process.execPath}' '${repository}/test/fixtures/codex.mjs'\n`,
    { mode: 0o755 },
  );
  const store = await StateStore.open(join(root, 'state'));
  const files = await store.create({
    id: 'desktop',
    title: 'Desktop fixture',
    cwd: project,
    agent: 'codex',
    sessions: {},
    createdAt: new Date().toISOString(),
  });
  await files.append({
    id: 'text',
    kind: 'assistant',
    cwd: project,
    text: Array.from(
      { length: 80 },
      (_, i) =>
        `[label${String(i + 1).padStart(3, '0')}](https://example.com/${i + 1})`,
    ).join('\n'),
  });
  await files.close();
  const child = spawn(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      '--import',
      join(repository, 'test/fixtures/cli-desktop.mjs'),
      join(repository, 'src/cli.tsx'),
      '--state-dir',
      store.root,
    ],
    {
      cwd: project,
      env: {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: root,
        TMPDIR: root,
        WITCH_CONVERSATION: 'desktop',
        WITCH_SCRATCH: undefined,
        WITCH_JOBS_RESUME: undefined,
        WITCH_JOBS: undefined,
        NODE_TEST_CONTEXT: undefined,
        TSX_TSCONFIG_PATH: join(repository, 'tsconfig.json'),
        NO_COLOR: undefined,
        FORCE_COLOR: '3',
        TERM: 'xterm-256color',
        CI: undefined,
      },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    },
  );
  const closed = once(child, 'close');
  void closed.catch(() => {});
  const messages: DesktopEvent[] = [];
  const screen = new Screen({ columns: 80, rows: 30 });
  let output = '';
  let stderr = '';
  child.stdout!.on('data', (chunk) => {
    output += chunk.toString();
    screen.write(chunk.toString());
  });
  child.stderr!.on('data', (chunk) => (stderr += chunk.toString()));
  child.on('message', (message) => messages.push(message as DesktopEvent));
  const wait = (name: string, check: () => unknown) =>
    until(name, () => {
      assert.equal(
        child.exitCode,
        null,
        `${name}: exited ${child.exitCode}; ${stderr}`,
      );
      return Boolean(check());
    });
  const mouse = (
    kind: 'press' | 'drag' | 'release',
    column: number,
    row: number,
  ) =>
    `\u001b[<${kind === 'drag' ? 32 : 0};${column + 1};${row + 1}${kind === 'release' ? 'm' : 'M'}`;
  const write = (data: string) => child.stdin!.write(data);
  try {
    await wait(
      'idle transcript',
      () =>
        output.includes('IDLE') &&
        screen.linkAt(1, 4)?.startsWith('https://example.com/'),
    );
    const first = screen.linkAt(1, 4)!;
    write(mouse('press', 1, 4));
    await delay(50);
    write('\u001b[5~');
    await wait(
      'changed link',
      () =>
        screen.linkAt(1, 4)?.startsWith('https://example.com/') &&
        screen.linkAt(1, 4) !== first,
    );
    const changed = screen.linkAt(1, 4)!;
    write(mouse('release', 1, 4));
    await wait('opened captured link', () =>
      messages.some((m) => m.file === '/usr/bin/open'),
    );
    assert.deepEqual(messages.find((m) => m.file === '/usr/bin/open')!.args, [
      first,
    ]);
    const expected = `label${changed.split('/').at(-1)!.padStart(3, '0')}`;
    write(
      mouse('press', 1, 4) +
        mouse('drag', 8, 4) +
        mouse('release', 8, 4) +
        '\u001b[99;9u',
    );
    await wait('copied payload', () =>
      messages.some((m) => m.file === '/usr/bin/pbcopy'),
    );
    assert.equal(
      messages.find((m) => m.file === '/usr/bin/pbcopy')!.text,
      expected,
    );
    assert.equal(messages.filter((m) => m.file === '/usr/bin/open').length, 1);
    child.send({ failure: '/usr/bin/pbcopy' });
    await wait('failure configured', () =>
      messages.some((m) => m.configured === '/usr/bin/pbcopy'),
    );
    write('\u001b[99;9u');
    await wait('copy failure reported', () =>
      stripAnsi(output).includes('fixture /usr/bin/pbcopy failed'),
    );
    assert.equal(
      messages.filter((m) => m.file === '/usr/bin/pbcopy').length,
      2,
    );
    child.send({ failure: '/usr/bin/open' });
    await wait('open failure configured', () =>
      messages.some((m) => m.configured === '/usr/bin/open'),
    );
    write(mouse('press', 1, 4) + mouse('release', 1, 4));
    await wait('open failure reported', () =>
      stripAnsi(output).includes('fixture /usr/bin/open failed'),
    );
    write('\u0003');
    const [code, signal] = await within(closed, 5000, 'CLI exit');
    assert.equal(code, 0, `${stderr} ${signal}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      try {
        await within(closed, 5000, 'CLI cleanup');
      } catch {
        child.kill('SIGKILL');
        await within(closed, 5000, 'CLI kill');
      }
    }
  }
});
