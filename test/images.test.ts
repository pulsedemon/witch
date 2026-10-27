import assert from 'node:assert/strict';
import childProcess, { execFileSync, spawn } from 'node:child_process';
import fs, { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { truncate, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import type { TestContext } from 'vitest';
import { test, vi } from 'vitest';
import { Graphics, imagePaths } from '../src/ui/images.js';
import { loaded } from './fixtures/graphics.js';
import { png } from './fixtures/png.js';
import { scratch } from './fixtures/scratch.js';

const placeholder = '\u{10EEEE}';
// the first Kitty row/column diacritics: rows 0, 1 and 2, and column 0
const [row0, row1, row2] = ['̅', '̍', '̎'];
const gif =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** the base64 payload of every transmission the writes carry, joined across chunks. */
const payload = (writes: string[]) =>
  writes
    .filter(
      (write) =>
        write.startsWith('\u001b_Ga=t,') || write.startsWith('\u001b_Gm='),
    )
    .map((write) => write.slice(write.indexOf(';') + 1, -2))
    .join('');

/** records each sips call with its input, read before the load removes it; on Linux, which has no sips, `linux` stands in. */
function sips(t: TestContext, linux: (output: string) => Error | null) {
  const calls: { file: string; args: readonly string[]; input: Buffer }[] = [];
  const execute = childProcess.execFile;
  t.onTestFinished(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });
  vi.spyOn(childProcess, 'execFile').mockImplementation((...call) => {
    const [file, args, , callback] = call;
    calls.push({ file, args: args ?? [], input: readFileSync(args![3]!) });
    if (process.platform !== 'linux') return execute(...call);
    callback?.(linux(args![5]!), '', '');
    return new childProcess.ChildProcess();
  });
  syncBuiltinESMExports();
  return calls;
}

test('a dropped path keeps its escaped spaces and unescaped U+202F, a quoted path keeps its spaces, and other files are not images', () => {
  assert.deepEqual(
    imagePaths(
      'see /tmp/Screenshot\\ 2026-10-14\\ at\\ 8.56.35 AM.png and "/tmp/a b.JPG" or notes.md',
    ),
    ['/tmp/Screenshot 2026-10-14 at 8.56.35 AM.png', '/tmp/a b.JPG'],
  );
});

test('an image loads in the background, then is sent once as its PNG data, shown by rows whose color names it and whose first cell names its row, and placed again without resending when the width changes', async (t) => {
  const directory = await scratch('witch-images-');
  const image = png(160, 80);
  const path = join(directory, 'shot.png');
  await writeFile(path, image);
  const writes: string[] = [];
  const graphics = new Graphics((data) => writes.push(data));
  const encoded: string[] = [];
  const other = new Graphics((data) => encoded.push(data));
  t.onTestFinished(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });
  const stats = vi.spyOn(fs, 'statSync');
  const reads = vi.spyOn(fs, 'readFileSync');
  syncBuiltinESMExports();

  const source = `~/${relative(homedir(), path)}`;
  assert.deepEqual(graphics.rows(source, directory, 100), []);
  assert.equal(writes.length, 0);
  assert.deepEqual(
    other.rows(`data:image/png;base64,${image.toString('base64')}`, '/', 100),
    [],
  );
  assert.equal(encoded.length, 0);
  assert.equal(stats.mock.calls.length, 0);
  assert.equal(reads.mock.calls.length, 0);

  await loaded(graphics);
  const rows = graphics.rows(source, directory, 100);
  // 160 pixels at 8 a column is 20 columns, and half as tall in cells as the image's 2:1 shape
  assert.deepEqual(
    rows,
    [row0, row1, row2, '̐', '̒'].map(
      (row) =>
        `\u001b[38;2;0;0;1m${placeholder}${row}${row0}${placeholder.repeat(19)}\u001b[39m`,
    ),
  );
  assert.ok(writes.length > 2, 'the image spans several chunks');
  assert.ok(writes[0]!.startsWith('\u001b_Ga=t,f=100,t=d,i=1,q=2,m=1;'));
  assert.equal(payload(writes), image.toString('base64'));
  assert.equal(writes.at(-1), '\u001b_Ga=p,U=1,i=1,p=1,c=20,r=5,q=2\u001b\\');

  writes.length = 0;
  assert.deepEqual(graphics.rows(path, directory, 100), rows);
  assert.deepEqual(graphics.rows('shot.png', directory, 100), rows);
  assert.deepEqual(writes, []);
  assert.equal(graphics.rows('shot.png', directory, 10).length, 3);
  assert.deepEqual(writes, ['\u001b_Ga=p,U=1,i=1,p=1,c=10,r=3,q=2\u001b\\']);
});

test('a GIF is sent converted to PNG, an unreadable path shows and sends nothing, and release frees each image sent', async (t) => {
  const writes: string[] = [];
  const graphics = new Graphics((data) => writes.push(data));
  const calls = sips(t, (output) => {
    writeFileSync(output, png(1, 1));
    return null;
  });
  assert.deepEqual(graphics.rows(gif, '/', 80), []);
  await loaded(graphics);
  assert.equal(calls.length, 1);
  const { file, args, input } = calls[0]!;
  assert.equal(file, '/usr/bin/sips');
  assert.equal(args.length, 6);
  assert.deepEqual(args.slice(0, 3), ['-s', 'format', 'png']);
  assert.equal(args[4], '--out');
  const converted = dirname(args[3]!);
  assert.equal(dirname(args[5]!), converted);
  assert.deepEqual(input, Buffer.from(gif.split(',')[1]!, 'base64'));
  assert.equal(graphics.rows(gif, '/', 80).length, 1);
  const sent = Buffer.from(payload(writes), 'base64');
  assert.deepEqual(
    [
      sent.subarray(1, 4).toString(),
      sent.readUInt32BE(16),
      sent.readUInt32BE(20),
    ],
    ['PNG', 1, 1],
  );
  assert.equal(existsSync(converted), false);

  writes.length = 0;
  assert.deepEqual(graphics.rows('/missing/shot.png', '/', 80), []);
  await loaded(graphics);
  assert.deepEqual(graphics.rows('/missing/shot.png', '/', 80), []);
  assert.equal(writes.length, 0);

  graphics.release();
  assert.deepEqual(writes, ['\u001b_Ga=d,d=I,i=1,q=2\u001b\\']);
});

test('a failed image conversion sends nothing and removes its temporary files', async (t) => {
  const calls = sips(t, () => new Error('fixture conversion failure'));
  const writes: string[] = [];
  const graphics = new Graphics((data) => writes.push(data));
  const source = 'data:image/gif;base64,bm90IGFuIGltYWdl';
  assert.deepEqual(graphics.rows(source, '/', 80), []);
  await loaded(graphics);
  assert.deepEqual(graphics.rows(source, '/', 80), []);
  assert.equal(writes.length, 0);
  assert.deepEqual(
    calls.map(({ file }) => file),
    ['/usr/bin/sips'],
  );
  assert.equal(existsSync(dirname(calls[0]!.args[3]!)), false);
});

test('a FIFO or a file over 64 MiB named like an image shows and reads nothing', async () => {
  const directory = await scratch('witch-images-');
  const source = join(directory, 'source.png');
  await writeFile(source, png(16, 16));
  const fifo = join(directory, 'fifo.png');
  execFileSync('/usr/bin/mkfifo', [fifo]);
  // a writer that would hand a reader a real image, so reading the FIFO would draw it
  const writer = spawn('/bin/cp', [source, fifo]);
  const large = join(directory, 'large.png');
  await writeFile(large, png(16, 16));
  await truncate(large, 64 * 1024 * 1024 + 1);
  const writes: string[] = [];
  const graphics = new Graphics((data) => writes.push(data));
  try {
    graphics.rows(fifo, '/', 80);
    graphics.rows(large, '/', 80);
    await loaded(graphics, 2);
    assert.deepEqual(graphics.rows(fifo, '/', 80), []);
    assert.deepEqual(graphics.rows(large, '/', 80), []);
    assert.equal(writes.length, 0);
  } finally {
    writer.kill();
  }
});

test('a failed path is retried only after 2 seconds, so an image written after its first failed load still shows', async (t) => {
  const directory = await scratch('witch-images-');
  const graphics = new Graphics(() => {});
  t.onTestFinished(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });
  vi.useFakeTimers({ toFake: ['Date'] });
  const stat = vi.spyOn(fs.promises, 'stat');
  syncBuiltinESMExports();
  const stats = () =>
    stat.mock.calls.filter(([path]) => String(path).endsWith('shot.png'))
      .length;

  assert.deepEqual(graphics.rows('shot.png', directory, 80), []);
  await loaded(graphics);
  assert.equal(stats(), 1);
  assert.equal(graphics.version, 0);
  await writeFile(join(directory, 'shot.png'), png(160, 80));
  assert.deepEqual(graphics.rows('shot.png', directory, 80), []);
  await setImmediate();
  assert.equal(stats(), 1);
  vi.setSystemTime(Date.now() + 1_999);
  assert.deepEqual(graphics.rows('shot.png', directory, 80), []);
  await setImmediate();
  assert.equal(stats(), 1);
  vi.setSystemTime(Date.now() + 1);
  assert.deepEqual(graphics.rows('shot.png', directory, 80), []);
  await loaded(graphics);
  assert.equal(stats(), 2);
  assert.equal(graphics.version, 1);
  assert.equal(graphics.rows('shot.png', directory, 80).length, 5);
});

test('release aborts a running conversion, drops queued loads, and writes nothing after', async (t) => {
  const directory = await scratch('witch-images-');
  const queued = join(directory, 'shot.png');
  await writeFile(queued, png(16, 16));
  const writes: string[] = [];
  const graphics = new Graphics((data) => writes.push(data));
  const conversions: Parameters<typeof childProcess.execFile>[] = [];
  t.onTestFinished(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });
  vi.spyOn(childProcess, 'execFile').mockImplementation((...call) => {
    // a load that wrongly converts fails at once, so the count catches it rather than loaded()'s timeout
    if (conversions.push(call) > 1)
      call[3]?.(new Error('converted after release'), '', '');
    return new childProcess.ChildProcess();
  });
  const stat = vi.spyOn(fs.promises, 'stat');
  syncBuiltinESMExports();

  graphics.rows(gif, '/', 80);
  graphics.rows(queued, '/', 80);
  await vi.waitFor(() => assert.ok(conversions[0]));
  graphics.release();
  const [, args, options, finish] = conversions[0]!;
  assert.equal(options?.signal?.aborted, true);
  // a conversion that finishes anyway
  writeFileSync(args![5]!, png(1, 1));
  finish!(null, '', '');
  await loaded(graphics, 2);
  assert.equal(writes.length, 0);
  assert.equal(conversions.length, 1);
  // the queued file is never read
  assert.equal(stat.mock.calls.length, 0);
  assert.equal(existsSync(dirname(args![3]!)), false);
});
