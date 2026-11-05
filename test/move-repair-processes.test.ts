import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, rename } from 'node:fs/promises';
import { test } from 'vitest';
import { identifyProcess } from '../src/persistence/process.js';
import { setup } from './fixtures/move-repair.js';

for (const race of ['source', 'parent', 'destination'])
  test(`a ${race} that changes while repair stops a leftover process keeps the conversation where it was`, async () => {
    const f = await setup();
    const cwd = race === 'parent' ? 'w/main/sub' : 'w/main';
    if (race === 'parent') await mkdir(f.at(cwd));
    // changes the paths as it's stopped, the last moment before the rewrite
    const change =
      race === 'destination'
        ? `fs.renameSync(${JSON.stringify(f.at('c/main'))}, ${JSON.stringify(f.at('actual'))}); fs.mkdirSync(${JSON.stringify(f.at('c/main'))});`
        : `fs.mkdirSync(${JSON.stringify(f.at('w/main'))}, { recursive: true });`;
    const child = spawn(process.execPath, [
      '-e',
      `const fs = require('node:fs'); process.on('SIGTERM', () => { ${change} process.exit(0); }); console.log('ready'); setTimeout(() => {}, 60_000);`,
    ]);
    try {
      await new Promise((ready) => child.stdout.once('data', ready));
      await f.save('live', cwd, {
        process: await identifyProcess(child.pid!),
      });
      await rename(f.at('w'), f.at('c'));
      const report = await f.repair('c/main');
      assert.equal((await f.saved('live')).raw.cwd, f.at(cwd));
      assert.ok(
        report.blocked.some(({ path }) => path === f.at(cwd)),
        JSON.stringify(report),
      );
    } finally {
      child.kill('SIGKILL');
    }
  });

test('a destination replaced between two conversations keeps the later one where it was', async () => {
  const f = await setup();
  // whichever stop comes first swaps the destination; the other conversation is checked against the ledger
  const swap = `if (!fs.existsSync(${JSON.stringify(f.at('actual'))})) { fs.renameSync(${JSON.stringify(f.at('c/main'))}, ${JSON.stringify(f.at('actual'))}); fs.mkdirSync(${JSON.stringify(f.at('c/main'))}); }`;
  const children = ['one', 'two'].map(() =>
    spawn(process.execPath, [
      '-e',
      `const fs = require('node:fs'); process.on('SIGTERM', () => { ${swap} process.exit(0); }); console.log('ready'); setTimeout(() => {}, 60_000);`,
    ]),
  );
  try {
    for (const [index, child] of children.entries()) {
      await new Promise((ready) => child.stdout.once('data', ready));
      await f.save(`live-${index}`, 'w/main', {
        process: await identifyProcess(child.pid!),
      });
    }
    await rename(f.at('w'), f.at('c'));
    await f.repair('c/main');
    for (const index of [0, 1])
      assert.equal((await f.saved(`live-${index}`)).raw.cwd, f.at('w/main'));
  } finally {
    for (const child of children) child.kill('SIGKILL');
  }
});

for (const field of ['process', 'usageProcess', 'answerProcess', 'shell'])
  test(`a recorded ${field} left running by a crash is stopped and its conversation repaired`, async () => {
    const f = await setup();
    // a recorded shell leads its own process group, which is what gets killed
    const child = spawn(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 60_000)'],
      { detached: field === 'shell' },
    );
    const exited = new Promise((done) => child.once('exit', done));
    try {
      const identity = await identifyProcess(child.pid!);
      await f.save('live', 'w/main', { [field]: identity });
      const before = (await f.saved('live')).mtimes;
      await rename(f.at('w'), f.at('c'));
      const report = await f.repair('c/main');
      assert.deepEqual(report.blocked, []);
      await exited;
      const after = await f.saved('live');
      assert.equal(after.raw.cwd, f.at('c/main'));
      assert.deepEqual(after.raw[field], identity);
      assert.deepEqual(after.mtimes, before);
    } finally {
      child.kill();
    }
  });

test('a live pid with a different start time is left running', async () => {
  const f = await setup();
  await f.save('reused', 'w/main', {
    process: { pid: process.pid, started: 'Thu Jan  1 00:00:00 1970' },
  });
  await rename(f.at('w'), f.at('c'));
  await f.repair('c/main');
  assert.equal((await f.saved('reused')).raw.cwd, f.at('c/main'));
});
