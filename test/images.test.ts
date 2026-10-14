import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Graphics, imagePaths } from '../src/ui/images.js';
import { png } from './fixtures/png.js';

const placeholder = '\u{10EEEE}';
// the first Kitty row/column diacritics: rows 0, 1 and 2, and column 0
const [row0, row1, row2] = ['̅', '̍', '̎'];

/** the base64 payload of every transmission the writes carry, joined across chunks. */
const payload = (writes: string[]) =>
  writes
    .filter(
      (write) =>
        write.startsWith('\u001b_Ga=t,') || write.startsWith('\u001b_Gm='),
    )
    .map((write) => write.slice(write.indexOf(';') + 1, -2))
    .join('');

await test('a dropped path keeps its escaped spaces and unescaped U+202F, a quoted path keeps its spaces, and other files are not images', () => {
  assert.deepEqual(
    imagePaths(
      'see /tmp/Screenshot\\ 2026-10-14\\ at\\ 8.56.35 AM.png and "/tmp/a b.JPG" or notes.md',
    ),
    ['/tmp/Screenshot 2026-10-14 at 8.56.35 AM.png', '/tmp/a b.JPG'],
  );
});

await test('an image is sent once as its PNG data, shown by rows whose color names it and whose first cell names its row, and placed again without resending when the width changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'witch-images-'));
  const image = png(160, 80);
  await writeFile(join(directory, 'shot.png'), image);
  const writes: string[] = [];
  const graphics = new Graphics((data) => writes.push(data));

  const rows = graphics.rows('shot.png', directory, 100);
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
  assert.deepEqual(graphics.rows('shot.png', directory, 100), rows);
  assert.deepEqual(writes, []);
  assert.equal(graphics.rows('shot.png', directory, 10).length, 3);
  assert.deepEqual(writes, ['\u001b_Ga=p,U=1,i=1,p=1,c=10,r=3,q=2\u001b\\']);
});

await test('a GIF is sent converted to PNG, an unreadable path shows and sends nothing, and release frees each image sent', () => {
  const writes: string[] = [];
  const graphics = new Graphics((data) => writes.push(data));
  const gif =
    'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
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

  writes.length = 0;
  assert.deepEqual(graphics.rows('/missing/shot.png', '/', 80), []);
  assert.deepEqual(writes, []);

  graphics.release();
  assert.deepEqual(writes, ['\u001b_Ga=d,d=I,i=1,q=2\u001b\\']);
});

await test('a FIFO or a file over 64 MiB named like an image shows and reads nothing, so it cannot stall a render', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'witch-images-'));
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
    assert.deepEqual(graphics.rows(fifo, '/', 80), []);
    assert.deepEqual(graphics.rows(large, '/', 80), []);
    assert.deepEqual(writes, []);
  } finally {
    writer.kill();
  }
});

await test('a path that failed to load is tried again, so an image written after a message names it still shows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'witch-images-'));
  const graphics = new Graphics(() => {});
  assert.deepEqual(graphics.rows('shot.png', directory, 80), []);
  await writeFile(join(directory, 'shot.png'), png(160, 80));
  assert.equal(graphics.rows('shot.png', directory, 80).length, 5);
});
