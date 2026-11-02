import assert from 'node:assert/strict';
import stripAnsi from 'strip-ansi';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import {
  mkdir,
  readFile,
  realpath,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { compiledCli } from './fixtures/compiled-cli.js';
import { scratch } from './fixtures/scratch.js';
import { until, within } from './fixtures/within.js';
import { StateStore } from '../src/persistence/store.js';
import { Screen } from '../src/ui/screen.js';
import { turnFrame } from './fixtures/codex-adapter.js';
import { png } from './fixtures/png.js';

interface DesktopEvent {
  diagnostic?: string;
  file?: string;
  args?: string[];
  text?: string;
  failed?: boolean;
  configured?: string;
}

test('the CLI opens the pressed link or image, copies selected text and runs queued prompts after desktop failures', async () => {
  const repository = fileURLToPath(new URL('../', import.meta.url));
  const root = await scratch('witch-cli-desktop-');
  const cli = await compiledCli();
  const project = join(root, 'project');
  const bin = join(root, 'bin');
  await mkdir(project, { recursive: true });
  await mkdir(bin, { recursive: true });
  const git = (
    await promisify(execFile)('/usr/bin/which', ['git'])
  ).stdout.trim();
  await symlink(git, join(bin, 'git'));
  await writeFile(
    join(bin, 'codex'),
    `#!/bin/sh\nexec '${process.execPath}' '${repository}/test/fixtures/codex.mjs' brews\n`,
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
  // a screenshot name's spaces and U+202F, and a tool's image that has no file until it is clicked
  const shot = join(project, 'Screenshot 2026-10-30 at 3.35.40\u202fPM.png');
  await writeFile(shot, png(16, 16));
  const toolImage = png(24, 24);
  await files.append({
    id: 'shot',
    kind: 'user',
    cwd: project,
    text: `see ${shot.replaceAll(' ', '\\ ')}`,
  });
  await files.append({
    id: 'read',
    kind: 'tool',
    title: 'Read',
    text: 'Image',
    cwd: project,
    done: true,
    images: [`data:image/png;base64,${toolImage.toString('base64')}`],
  });
  await files.append({
    id: 'text',
    kind: 'assistant',
    cwd: project,
    text: Array.from(
      { length: 80 },
      (_, i) =>
        `[label${String(i + 1).padStart(3, '0')}](https://example.com/${i + 1}) [bad](vscode://file${project}/bad%.md) [memory](missing-note.md)`,
    ).join('\n'),
  });
  await files.close();
  const spawned = performance.now();
  const child = spawn(
    process.execPath,
    [
      '--import',
      join(repository, 'test/fixtures/cli-desktop.mjs'),
      cli,
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
  // the CLI's own Screen records only what Ink draws, so image transmissions, which go around Ink, are left out
  let transmission = '';
  child.stdout!.on('data', (chunk) => {
    output += chunk.toString();
    const text = transmission + chunk.toString();
    const open = text.lastIndexOf('\u001b_G');
    const end =
      open >= 0 && !text.includes('\u001b\\', open) ? open : text.length;
    transmission = text.slice(end);
    // eslint-disable-next-line no-control-regex
    screen.write(text.slice(0, end).replace(/\u001b_G[^\u001b]*\u001b\\/g, ''));
  });
  child.stderr!.on('data', (chunk) => (stderr += chunk.toString()));
  const diagnostics: string[] = [];
  child.on('message', (message: DesktopEvent) => {
    if (message.diagnostic !== undefined) {
      diagnostics.push(message.diagnostic);
      if (diagnostics.length > 64) diagnostics.shift();
    } else messages.push(message);
  });
  const wait = (name: string, check: () => unknown, attempts?: number) => {
    const started = performance.now();
    return until(
      name,
      async () => {
        assert.equal(
          child.exitCode,
          null,
          `${name}: exited ${child.exitCode}; ${stderr}`,
        );
        return Boolean(await check());
      },
      attempts,
    ).catch((error: unknown) => {
      throw new Error(
        `${name}: ${stripAnsi(output)}\n${stderr}\n${JSON.stringify({
          pid: child.pid,
          exitCode: child.exitCode,
          signalCode: child.signalCode,
          sinceSpawn: performance.now() - spawned,
          waiting: performance.now() - started,
          diagnostics,
        })}`,
        { cause: error },
      );
    });
  };
  const mouse = (
    kind: 'press' | 'drag' | 'release',
    column: number,
    row: number,
  ) =>
    `\u001b[<${kind === 'drag' ? 32 : 0};${column + 1};${row + 1}${kind === 'release' ? 'm' : 'M'}`;
  const write = (data: string) => child.stdin!.write(data);
  const submit = async (text: string) => {
    const start = output.length;
    write(text);
    await wait('composer text', () =>
      stripAnsi(output.slice(start)).includes(text),
    );
    write('\r');
  };
  const request = async (name: string) => {
    const text = await readFile(join(project, `${name}.json`), 'utf8').catch(
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          return undefined;
        throw error;
      },
    );
    return text === undefined ? undefined : JSON.parse(text);
  };
  const configure = async (failure: string) => {
    const start = messages.length;
    child.send({ failure });
    await wait('failure configured', () =>
      messages.slice(start).some((message) => message.configured === failure),
    );
  };
  const finish = async (turn: number) => {
    const path = join(project, `events-${turn}.json`);
    await writeFile(
      `${path}.next`,
      JSON.stringify([turnFrame(`turn-${turn}`)]),
    );
    await rename(`${path}.next`, path);
  };
  const linkCell = (matches: (url: string) => boolean) => {
    for (let row = 0; row < 30; row++)
      for (let column = 0; column < 80; column++) {
        const url = screen.linkAt(column, row);
        if (url && matches(url)) return { column, row };
      }
    return undefined;
  };
  try {
    await wait(
      'idle transcript',
      () =>
        output.includes('IDLE') &&
        screen.linkAt(1, 4)?.startsWith('https://example.com/'),
      500,
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
    let turn = 0;
    for (const [kind, failure, errorText] of [
      ['copy', '/usr/bin/pbcopy', 'fixture /usr/bin/pbcopy failed'],
      ['open', '/usr/bin/open', 'fixture /usr/bin/open failed'],
      ['malformed', 'none', 'URI malformed'],
      ['memory', 'memoryDirectories', 'fixture memory lookup failed'],
    ] as const) {
      const held = ++turn;
      await submit(`hold for ${kind}`);
      await wait('held native turn', () => request(`turn-${held}`));
      const queuedAt = output.length;
      await submit('refused');
      await wait('refused steer stays queued', async () => {
        const steer = await request('steer');
        return (
          steer?.params.expectedTurnId === `turn-${held}` &&
          steer.params.input[0].text === 'refused' &&
          stripAnsi(output.slice(queuedAt)).includes('edit queued messages')
        );
      });
      await configure(failure);
      const matches = (url: string) =>
        kind === 'malformed'
          ? url.includes('bad%.md')
          : kind === 'memory'
            ? url.endsWith('/missing-note.md')
            : url.startsWith('https://example.com/');
      write('\u001b[5~');
      await wait('clickable target', () => linkCell(matches));
      const cell = linkCell(matches)!;
      const failedAt = output.length;
      const opened = messages.filter((m) => m.file === '/usr/bin/open').length;
      if (kind === 'copy')
        write(
          mouse('press', cell.column, cell.row) +
            mouse('drag', cell.column + 7, cell.row) +
            mouse('release', cell.column + 7, cell.row) +
            '\u001b[99;9u',
        );
      else
        write(
          mouse('press', cell.column, cell.row) +
            mouse('release', cell.column, cell.row),
        );
      write('\u001b[6~\u001b[6~');
      await wait(`${kind} failure reported`, () =>
        stripAnsi(output.slice(failedAt)).includes(errorText),
      );
      if (kind === 'copy')
        assert.equal(
          messages.filter((m) => m.file === '/usr/bin/pbcopy').length,
          2,
        );
      if (kind === 'malformed' || kind === 'memory')
        assert.equal(
          messages.filter((m) => m.file === '/usr/bin/open').length,
          opened,
        );
      await configure('none');
      await finish(held);
      const next = ++turn;
      await wait(`${kind} failure allows the followup`, () =>
        request(`turn-${next}`),
      );
      assert.equal(
        (await request(`turn-${next}`)).params.input[0].text,
        'refused',
      );
      const idleAt = output.length;
      await finish(next);
      await wait('followup completed', () =>
        output.slice(idleAt).includes('IDLE'),
      );
    }

    /** clicks the bottom row of an image whose link `matches` accepts, resolving to the target the CLI opened. */
    const open = async (name: string, matches: (url: string) => boolean) => {
      const bottom = () => {
        let found: { column: number; row: number } | undefined;
        const rows = new Set<number>();
        for (let row = 0; row < 30; row++)
          for (let column = 0; column < 80; column++) {
            const url = screen.linkAt(column, row);
            if (url && matches(url)) {
              found = { column, row };
              rows.add(row);
            }
          }
        // a loaded image spans rows below any text link to its file
        return rows.size > 1 ? found : undefined;
      };
      await wait(name, bottom);
      const cell = bottom()!;
      write(
        mouse('press', cell.column, cell.row) +
          mouse('release', cell.column, cell.row),
      );
      // an earlier open's report can arrive after the notice its failure showed
      const opened = () =>
        messages.find(
          (m) => m.file === '/usr/bin/open' && matches(m.args![0]!),
        );
      await wait(`${name} opened`, opened);
      return opened()!.args![0]!;
    };
    write('\u001b[5~'.repeat(10));
    // open gets the real path, which differs where TMPDIR sits under a symlink such as macOS /var
    const shotLink = pathToFileURL(await realpath(shot)).href;
    await open('screenshot image', (url) => url === shotLink);
    const focused = output.length;
    write('\t');
    await wait('tool focus', () =>
      stripAnsi(output.slice(focused)).includes('TOOLS'),
    );
    write('\r');
    const saved = await open('tool image', (url) =>
      url.includes('witch-images-'),
    );
    assert.deepEqual(await readFile(fileURLToPath(saved)), toolImage);
    write('\u0003');
    const [code, signal] = await within(closed, 5000, 'CLI exit');
    assert.equal(code, 0, `${stderr} ${signal}`);
    assert.equal(existsSync(fileURLToPath(saved)), false);
  } finally {
    await writeFile(join(project, 'release'), 'yes');
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
