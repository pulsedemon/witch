import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import fs, { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { TestContext } from 'vitest';
import { test, vi } from 'vitest';
import { Attachments, imagePaste } from '../src/core/attachments.js';
import { StateStore } from '../src/persistence/store.js';
import { fixture, record } from './fixtures/coordinator.js';
import { png } from './fixtures/png.js';
import { scratch } from './fixtures/scratch.js';
import { within } from './fixtures/within.js';

const pngSignature = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** a path as Ghostty drops it: a backslash before each character its shell escaping names, and U+202F left as it is. */
const dropped = (path: string) =>
  path.replace(/[\\ ()[\]{}<>"'`!#$&;|*?\t]/g, '\\$&');

/** stands in for sips on any platform: a size probe reports `sides`, and a conversion writes `converted`. */
function sips(
  t: TestContext,
  sides: [number, number],
  { converted = Buffer.from('converted jpeg'), failures = 0 } = {},
) {
  const calls: { args: string[]; input: Buffer }[] = [];
  let failing = failures;
  t.onTestFinished(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });
  vi.spyOn(childProcess, 'execFile').mockImplementation((...call) => {
    const [, args, , callback] = call as unknown as [
      string,
      string[],
      unknown,
      (error: Error | null, stdout: string) => void,
    ];
    const out = args.indexOf('--out');
    calls.push({ args, input: readFileSync(args.at(out === -1 ? -1 : -3)!) });
    if (failing-- > 0) callback(new Error('sips failed'), '');
    else if (out === -1)
      callback(
        null,
        `x\n  pixelWidth: ${sides[0]}\n  pixelHeight: ${sides[1]}\n`,
      );
    else {
      writeFileSync(args[out + 1]!, converted);
      callback(null, '');
    }
    return new childProcess.ChildProcess();
  });
  syncBuiltinESMExports();
  return calls;
}

/** a conversation's store, closed when the test finishes. */
async function conversationStore(t: TestContext, id = 'images') {
  const store = await StateStore.open(await scratch('witch-attachments-'));
  const files = await store.create(record(id, '/project'));
  t.onTestFinished(() => files.close());
  return files;
}

/** a JPEG's width and height, read from its start-of-frame segment. */
function jpegSize(data: Buffer): [number, number] {
  for (let offset = 2; offset < data.length;) {
    const marker = data[offset + 1]!;
    if (marker >= 0xc0 && marker <= 0xc3)
      return [data.readUInt16BE(offset + 7), data.readUInt16BE(offset + 5)];
    offset += 2 + data.readUInt16BE(offset + 2);
  }
  throw new Error('no start-of-frame segment');
}

test('a paste that lists only readable images gives their absolute paths, in order, however the terminal escaped or quoted them', async () => {
  const directory = await scratch('witch-paste-');
  const screenshot = join(directory, 'Screenshot 2026-10-14 at 8.56.35 AM.png');
  const every = join(directory, 'all \\ ()[]{}<>"\'`!#$&;|*?\t.png');
  const spaced = join(directory, 'a b.png');
  const backslashed = join(directory, 'quoted\\ name.png');
  const photo = join(directory, 'c.jpg');
  for (const path of [screenshot, every, spaced, backslashed, photo])
    await writeFile(path, png(1, 1));
  // the escaped drop of `a b.png` must not name this file, which a backslash taken literally would
  await writeFile(join(directory, 'a\\ b.png'), 'other');
  for (const [paste, expected] of [
    [dropped(screenshot), [screenshot]],
    [dropped(every), [every]],
    [`  ${spaced}\n`, [spaced]],
    [`~/${relative(homedir(), photo)}`, [photo]],
    [`'${backslashed}'`, [backslashed]],
    [`${dropped(photo)} ${dropped(spaced)}`, [photo, spaced]],
    [`"${spaced}" '${photo}'`, [spaced, photo]],
    [dropped(spaced), [spaced]],
  ] as const)
    assert.deepEqual(imagePaste(paste), expected, paste);
});

test('a paste is text when anything in it is not a readable image named by an absolute path', async () => {
  const directory = await scratch('witch-paste-');
  const shot = join(directory, 'shot.png');
  await writeFile(shot, png(1, 1));
  for (const name of ['notes.md', 'doc.pdf'])
    await writeFile(join(directory, name), 'text');
  for (const paste of [
    `"${shot}""${shot}"`,
    join(directory, 'notes.md'),
    join(directory, 'missing.png'),
    // names the file from `/`, which the check resolves against
    relative('/', shot),
    `${shot} ${join(directory, 'doc.pdf')}`,
    `look at ${shot} please`,
    `${shot} \\`,
  ])
    assert.equal(imagePaste(paste), undefined, paste);
});

test('attached images are numbered from 1 and keep the bytes pasted, though the file is then removed', async (t) => {
  const directory = await scratch('witch-attach-');
  const [first, second] = [png(2, 2), png(3, 3)];
  await writeFile(join(directory, 'first.png'), first);
  await writeFile(join(directory, 'second.png'), second);
  const attachments = new Attachments();
  assert.equal(attachments.attach(join(directory, 'first.png')), '[Image #1]');
  assert.equal(attachments.attach(join(directory, 'second.png')), '[Image #2]');
  await rm(directory, { recursive: true });
  const saved = await attachments.prepare([2, 1], await conversationStore(t));
  assert.deepEqual(await Promise.all(saved.map((path) => readFile(path))), [
    second,
    first,
  ]);
});

test('a prompt resolves the registered markers it names in order, each once, and leaves unregistered and broken ones as text', async () => {
  const directory = await scratch('witch-attach-');
  await writeFile(join(directory, 'shot.png'), png(1, 1));
  const attachments = new Attachments();
  for (let index = 0; index < 3; index++)
    attachments.attach(join(directory, 'shot.png'));
  assert.deepEqual(
    attachments.resolve(
      '[Image #3] then [Image #1], [Image #3] again, [Image #9] [Image #2 [Image 2]',
    ),
    [3, 1],
  );
});

test('a small PNG is saved byte for byte without sips, once per conversation, and saved again for another conversation', async (t) => {
  const calls = sips(t, [1, 1]);
  const directory = await scratch('witch-attach-');
  const [first, second] = [png(4, 4), png(5, 5)];
  await writeFile(join(directory, 'first.png'), first);
  await writeFile(join(directory, 'second.png'), second);
  const attachments = new Attachments();
  attachments.attach(join(directory, 'first.png'));
  attachments.attach(join(directory, 'second.png'));
  const one = await conversationStore(t, 'one');
  const other = await conversationStore(t, 'other');
  // a steer and the turn that runs it prepare the same marker at once
  const [saved, shared] = await Promise.all([
    attachments.prepare([1, 2], one),
    attachments.prepare([2], one),
  ]);
  assert.deepEqual(shared, [saved[1]]);
  assert.deepEqual(await attachments.prepare([2, 1], one), saved.toReversed());
  const elsewhere = await attachments.prepare([1], other);
  assert.equal(dirname(elsewhere[0]!), join(other.directory, 'images'));
  for (const path of saved)
    assert.equal(dirname(path), join(one.directory, 'images'));
  assert.equal((await readdir(join(one.directory, 'images'))).length, 2);
  assert.deepEqual(
    await Promise.all([...saved, ...elsewhere].map((path) => readFile(path))),
    [first, second, first],
  );
  assert.ok(saved.every((path) => path.endsWith('.png')));
  assert.equal(calls.length, 0);
});

test('an image whose conversion failed is converted again on its next delivery', async (t) => {
  const calls = sips(t, [64, 64], { failures: 1 });
  const directory = await scratch('witch-attach-');
  await writeFile(join(directory, 'photo.jpg'), 'jpeg bytes');
  const attachments = new Attachments();
  attachments.attach(join(directory, 'photo.jpg'));
  const store = await conversationStore(t);
  await assert.rejects(attachments.prepare([1], store), /sips failed/);
  const [saved] = await attachments.prepare([1], store);
  assert.equal(calls.length, 3);
  assert.ok(saved!.endsWith('.jpg'));
  assert.equal(await readFile(saved!, 'utf8'), 'converted jpeg');
});

test('cancel stops a running conversion, and the next delivery converts again', async (t) => {
  const directory = await scratch('witch-attach-');
  await writeFile(join(directory, 'photo.jpg'), 'jpeg bytes');
  const attachments = new Attachments();
  attachments.attach(join(directory, 'photo.jpg'));
  const store = await conversationStore(t);
  t.onTestFinished(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });
  const started = Promise.withResolvers<void>();
  vi.spyOn(childProcess, 'execFile').mockImplementation((...call) => {
    const [, , { signal }, callback] = call as unknown as [
      string,
      string[],
      { signal: AbortSignal },
      (error: Error | null, stdout: string) => void,
    ];
    // a sips that never finishes on its own
    signal.addEventListener('abort', () => callback(new Error('aborted'), ''));
    started.resolve();
    return new childProcess.ChildProcess();
  });
  syncBuiltinESMExports();
  const preparing = attachments.prepare([1], store);
  await started.promise;
  attachments.cancel();
  await assert.rejects(
    within(preparing, 2000, 'the cancelled conversion'),
    /aborted/,
  );
  vi.restoreAllMocks();
  const calls = sips(t, [64, 64]);
  const [saved] = await attachments.prepare([1], store);
  assert.equal(calls.length, 2);
  assert.equal(await readFile(saved!, 'utf8'), 'converted jpeg');
});

for (const [name, data, sides, fit] of [
  ['a JPEG', Buffer.from('jpeg bytes'), [64, 64], []],
  ['a PNG wider than 2,000 px', png(3000, 1), [3000, 1], ['-Z', '2000']],
  ['a PNG whose base64 is over 5 MB', png(2000, 2000), [2000, 2000], []],
] as const)
  test(`${name} is converted to a JPEG, fitted to 2,000 px only when a side is over it, through a directory removed after`, async (t) => {
    const isPng = data.subarray(0, 8).equals(pngSignature);
    assert.equal(isPng, name !== 'a JPEG');
    if (isPng) {
      assert.deepEqual([data.readUInt32BE(16), data.readUInt32BE(20)], sides);
      assert.equal(
        Math.ceil(data.length / 3) * 4 > 5 * 1024 * 1024,
        name === 'a PNG whose base64 is over 5 MB',
      );
    }
    const calls = sips(t, [...sides]);
    const directory = await scratch('witch-attach-');
    await writeFile(join(directory, 'image'), data);
    const attachments = new Attachments();
    attachments.attach(join(directory, 'image'));
    const [saved] = await attachments.prepare([1], await conversationStore(t));
    const [probe, convert] = calls;
    assert.equal(calls.length, 2);
    assert.deepEqual(probe!.args.slice(0, -1), [
      '-g',
      'pixelWidth',
      '-g',
      'pixelHeight',
    ]);
    assert.deepEqual(convert!.args.slice(0, -3), [
      '-s',
      'format',
      'jpeg',
      ...fit,
    ]);
    assert.equal(convert!.args.at(-3), probe!.args.at(-1));
    assert.ok(probe!.input.equals(data));
    assert.equal(existsSync(dirname(probe!.args.at(-1)!)), false);
    assert.ok(saved!.endsWith('.jpg'));
    assert.equal(await readFile(saved!, 'utf8'), 'converted jpeg');
  });

test.runIf(process.platform === 'darwin')(
  'sips fits a 3,000 px PNG to a 2,000 px JPEG and leaves a 64 px JPEG at 64 px',
  async (t) => {
    const directory = await scratch('witch-attach-');
    await writeFile(join(directory, 'wide.png'), png(3000, 30));
    await writeFile(join(directory, 'small.png'), png(64, 64));
    execFileSync('/usr/bin/sips', [
      ...['-s', 'format', 'jpeg', join(directory, 'small.png')],
      ...['--out', join(directory, 'small.jpg')],
    ]);
    assert.deepEqual(
      jpegSize(readFileSync(join(directory, 'small.jpg'))),
      [64, 64],
    );
    const attachments = new Attachments();
    attachments.attach(join(directory, 'wide.png'));
    attachments.attach(join(directory, 'small.jpg'));
    const saved = await attachments.prepare([1, 2], await conversationStore(t));
    assert.ok(saved.every((path) => path.endsWith('.jpg')));
    assert.deepEqual(
      await Promise.all(
        saved.map(async (path) => jpegSize(await readFile(path))),
      ),
      [
        [2000, 20],
        [64, 64],
      ],
    );
  },
);

test('a pasted image becomes its marker, spaced from a word before it, and a file removed while it is checked leaves the paste as text', async (t) => {
  const { coordinator, root } = await fixture();
  try {
    const [shot, photo] = [join(root, 'shot.png'), join(root, 'photo.jpg')];
    await writeFile(shot, png(1, 1));
    await writeFile(photo, 'jpeg bytes');
    assert.equal(coordinator.paste(shot, 'session'), ' [Image #1]');
    assert.equal(coordinator.paste(shot, 'session '), '[Image #2]');
    assert.equal(
      coordinator.paste(`${shot} ${photo}`, ''),
      '[Image #3] [Image #4]',
    );
    assert.equal(coordinator.paste('plain words', 'session'), undefined);
    t.onTestFinished(() => {
      vi.restoreAllMocks();
      syncBuiltinESMExports();
    });
    const stat = fs.statSync;
    vi.spyOn(fs, 'statSync').mockImplementation(((
      ...args: Parameters<typeof fs.statSync>
    ) => {
      const stats = stat(...args);
      rmSync(shot, { force: true });
      return stats;
    }) as typeof fs.statSync);
    syncBuiltinESMExports();
    assert.equal(coordinator.paste(shot, 'session'), undefined);
  } finally {
    await coordinator.close();
  }
});
