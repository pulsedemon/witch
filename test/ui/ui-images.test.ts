import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { createElement } from 'react';
import { test, vi } from 'vitest';
import { App } from '../../src/ui/App.js';
import { Graphics, placeholder } from '../../src/ui/transcript/images.js';
import { unitFixture } from '../fixtures/coordinator.js';
import { png } from '../fixtures/png.js';
import { scratch } from '../fixtures/scratch.js';
import { fake, show } from '../fixtures/ui.js';
import { until } from '../fixtures/within.js';

test('typing stays responsive while an image converts, and the image shows once the conversion finishes', async (t) => {
  const directory = await scratch('witch-ui-images-');
  await writeFile(join(directory, 'shot.jpg'), 'not a png');
  const graphics = new Graphics(() => {});

  const { app } = fake({
    items: [
      {
        id: 'message',
        kind: 'user',
        text: 'look at [Image #1]',
        cwd: directory,
        images: ['shot.jpg'],
      },
    ],
  });

  const conversions: Parameters<typeof childProcess.execFile>[] = [];
  const execute = childProcess.execFile;

  t.onTestFinished(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });

  vi.spyOn(childProcess, 'execFile').mockImplementation((...call) => {
    if (call[0] !== '/usr/bin/sips') return execute(...call);

    conversions.push(call);

    return new childProcess.ChildProcess();
  });

  syncBuiltinESMExports();

  const ui = show(
    createElement(App, { coordinator: app, graphics, onExit: () => {} }),
  );

  try {
    await until('the conversion', () => conversions.length > 0);
    ui.stdin.write('abc');
    await until('the draft', () => ui.text().includes('┃ abc'));
    const [, args, , finish] = conversions[0]!;
    await writeFile(args![5]!, png(160, 80));
    finish!(null, '', '');
    await until('the image', () => ui.text().includes(placeholder));
  } finally {
    ui.unmount();
    graphics.release();
  }
});

test('a reopened conversation still draws the image a message was sent with after the pasted file is gone', async () => {
  const { coordinator, a, project, reopen } = await unitFixture();
  const shot = join(project, 'shot.png');
  await writeFile(shot, png(160, 80));
  await coordinator.send(`look at${coordinator.paste(shot, 'look at')!}`);
  assert.equal(a.inputs[0]!.images?.length, 1);
  await coordinator.close();
  await rm(shot);
  const reopened = await reopen();
  const graphics = new Graphics(() => {});

  const ui = show(
    createElement(App, { coordinator: reopened, graphics, onExit: () => {} }),
  );

  try {
    await until('the image', () => ui.text().includes(placeholder));
    assert.ok(ui.text().includes('look at [Image #1]'), ui.text());
  } finally {
    ui.unmount();
    graphics.release();
    await reopened.close();
  }
});
