import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'vitest';
import { appears, until, within } from '../../fixtures/within.js';
import {
  fixture,
  close,
  controlledFixture,
  commandFrame,
  turnFrame,
} from '../../fixtures/codex-adapter.js';

const terminals = (...entries: [string, string][]) => ({
  data: entries.map(([itemId, command], index) => ({
    itemId,
    command,
    processId: String(index + 1),
    cwd: '/fixture',
    osPid: null,
    cpuPercent: null,
    rssKb: null,
  })),
  nextCursor: null,
});

test('Codex commands become brews only after their originating turn ends', async () => {
  const f = await controlledFixture();

  try {
    const first = f.session.send('first');
    await appears(join(f.cwd, 'turn-1.json'));
    await f.emit(commandFrame('short'), commandFrame('long'));
    assert.deepEqual(f.commands(), []);

    await assert.rejects(access(join(f.cwd, 'list-1.json')), {
      code: 'ENOENT',
    });

    await f.emit(
      commandFrame('short', 'turn-1', 'native-thread', 'completed'),
      turnFrame(),
    );

    assert.equal((await within(first, 2000, 'first turn')).status, 'completed');
    await appears(join(f.cwd, 'list-1.json'));
    const second = f.session.send('second');
    await appears(join(f.cwd, 'turn-2.json'));
    await f.emit(turnFrame('turn-2'));

    assert.equal(
      (await within(second, 2000, 'second turn')).status,
      'completed',
    );

    await appears(join(f.cwd, 'list-2.json'));
    assert.deepEqual(f.commands(), []);
    await f.reply(2, { result: terminals(['long', 'run the long command']) });
    await f.reply(1, { result: terminals(['long', 'run the long command']) });

    assert.deepEqual(f.commands(), [
      {
        id: 'native-thread/long',
        description: 'run the long command',
        status: 'running',
      },
    ]);

    await f.emit(commandFrame('long', 'turn-1', 'native-thread', 'completed'));

    assert.deepEqual(
      f.commands().map(({ status }) => status),
      ['running', 'completed'],
    );

    assert.equal(f.commands()[1]!.id, f.commands()[0]!.id);
    assert.equal(f.commands()[1]!.description, 'run the long command');
  } finally {
    await close(f.session, f.cwd);
  }
});

test('Codex brew order follows command starts', async () => {
  const f = await controlledFixture();

  try {
    const sending = f.session.send('order');
    await appears(join(f.cwd, 'turn-1.json'));
    await f.emit(commandFrame('a'), commandFrame('b'), turnFrame());
    await sending;

    await f.reply(1, {
      result: terminals(['b', 'second command'], ['a', 'first command']),
    });

    assert.deepEqual(
      f.commands().map(({ description }) => description),
      ['first command', 'second command'],
    );

    const request = JSON.parse(
      await readFile(join(f.cwd, 'list-1.json'), 'utf8'),
    );

    assert.deepEqual(request.params, { threadId: 'native-thread' });
  } finally {
    await close(f.session, f.cwd);
  }
});

test('a Codex brew listed on a later terminal page still becomes a brew', async () => {
  const f = await controlledFixture();

  try {
    const sending = f.session.send('paged');
    await appears(join(f.cwd, 'turn-1.json'));
    await f.emit(commandFrame('late'), turnFrame());
    await sending;

    await f.reply(1, {
      result: {
        ...terminals(['other', 'unrelated command']),
        nextCursor: 'page-2',
      },
    });

    await appears(join(f.cwd, 'list-2.json'));

    const request = JSON.parse(
      await readFile(join(f.cwd, 'list-2.json'), 'utf8'),
    );

    assert.equal(request.params.cursor, 'page-2');
    assert.deepEqual(f.commands(), []);
    await f.reply(2, { result: terminals(['late', 'second page command']) });

    assert.deepEqual(f.commands(), [
      {
        id: 'native-thread/late',
        description: 'second page command',
        status: 'running',
      },
    ]);
  } finally {
    await close(f.session, f.cwd);
  }
});

describe('a stale terminal list cannot revive a completed command or admit a later foreground command', () => {
  for (const stale of [true, false])
    test(stale ? 'old snapshot' : 'later snapshot', async () => {
      const f = await controlledFixture();

      try {
        const first = f.session.send('first');
        await appears(join(f.cwd, 'turn-1.json'));
        await f.emit(commandFrame('live'));

        if (stale) await f.emit(commandFrame('gone'), commandFrame('reused'));

        await f.emit(turnFrame());
        await first;
        await appears(join(f.cwd, 'list-1.json'));

        if (stale)
          await f.emit(
            commandFrame('gone', 'turn-1', 'native-thread', 'completed'),
            commandFrame('reused', 'turn-1', 'native-thread', 'completed'),
          );

        const second = f.session.send('second');
        await appears(join(f.cwd, 'turn-2.json'));
        const laterId = stale ? 'reused' : 'new';
        await f.emit(commandFrame(laterId, 'turn-2'));
        const listing: [string, string][] = [['live', 'survivor']];

        if (stale) listing.push(['gone', 'old gone'], ['reused', 'old reused']);
        else listing.push(['new', 'foreground']);

        await f.reply(1, { result: terminals(...listing) });

        assert.deepEqual(
          f.commands().map(({ description }) => description),
          ['survivor'],
        );

        await f.emit(
          commandFrame('live', 'turn-1', 'native-thread', 'completed'),
          commandFrame(laterId, 'turn-2', 'native-thread', 'completed'),
          turnFrame('turn-2'),
        );

        await second;

        assert.deepEqual(
          f.commands().map(({ status }) => status),
          ['running', 'completed'],
        );
      } finally {
        await close(f.session, f.cwd);
      }
    });
});

describe('Codex brews survive turn interruption and retain native terminal results', () => {
  for (const [turnStatus, status, exitCode, expected] of [
    ['interrupted', 'completed', 0, 'completed'],
    ['failed', 'failed', -1, 'failed'],
    ['completed', 'declined', -1, 'failed'],
    ['completed', 'failed', 7, 'failed'],
  ] as const)
    test(`${turnStatus} turn, ${status} command, exit ${exitCode}`, async () => {
      const f = await controlledFixture();

      try {
        const sending = f.session.send('status');
        await appears(join(f.cwd, 'turn-1.json'));
        await f.emit(commandFrame('command'), turnFrame('turn-1', turnStatus));
        assert.equal((await sending).status, turnStatus);

        await f.reply(1, {
          result: terminals(['command', 'surviving command']),
        });

        assert.deepEqual(
          f.commands().map(({ status }) => status),
          ['running'],
        );

        if (turnStatus === 'interrupted') {
          const later = f.session.send('later');
          await appears(join(f.cwd, 'turn-2.json'));
          await f.emit(turnFrame('turn-2', 'interrupted'));
          assert.equal((await later).status, 'interrupted');

          assert.deepEqual(
            f.commands().map(({ status }) => status),
            ['running'],
          );
        }

        await f.emit(
          commandFrame('command', 'turn-1', 'native-thread', status, exitCode),
        );

        assert.deepEqual(
          f.commands().map(({ status }) => status),
          ['running', expected],
        );
      } finally {
        await close(f.session, f.cwd);
      }
    });
});

test("a child's late command completion ends only its own brew", async () => {
  const f = await controlledFixture();

  try {
    await f.emit(
      turnFrame('old', 'inProgress', 'child-thread'),
      turnFrame('other', 'inProgress', 'grandchild-thread'),
      commandFrame('command', 'old', 'child-thread'),
      commandFrame('command', 'other', 'grandchild-thread'),
      commandFrame('unknown', 'stray', 'unknown-thread'),
      commandFrame('unknown', 'stray', 'unknown-thread', 'completed'),
      turnFrame('old', 'completed', 'child-thread'),
      turnFrame('other', 'completed', 'grandchild-thread'),
    );

    await f.reply(1, { result: terminals(['command', 'first child command']) });

    await f.reply(2, {
      result: terminals(['command', 'second child command']),
    });

    await assert.rejects(access(join(f.cwd, 'list-3.json')), {
      code: 'ENOENT',
    });

    assert.deepEqual(
      f.commands().map(({ id }) => id),
      ['child-thread/command', 'grandchild-thread/command'],
    );

    await f.emit(
      turnFrame('new', 'inProgress', 'child-thread'),
      commandFrame('command', 'old', 'child-thread', 'completed'),
    );

    assert.deepEqual(
      f.commands().map(({ id, status }) => [id, status]),
      [
        ['child-thread/command', 'running'],
        ['grandchild-thread/command', 'running'],
        ['child-thread/command', 'completed'],
      ],
    );

    await f.emit(
      commandFrame('command', 'other', 'grandchild-thread', 'failed', 7),
    );

    assert.equal(f.commands()[3]!.id, 'grandchild-thread/command');
    assert.equal(f.commands()[3]!.status, 'failed');
  } finally {
    await close(f.session, f.cwd);
  }
});

test('terminal discovery failure preserves the turn and retries at the next turn end', async () => {
  const f = await controlledFixture();

  try {
    for (let index = 1; index <= 3; index++) {
      const sending = f.session.send(`turn ${index}`);
      await appears(join(f.cwd, `turn-${index}.json`));

      if (index === 1) await f.emit(commandFrame('command'));

      await f.emit(turnFrame(`turn-${index}`));
      assert.equal((await sending).status, 'completed');

      await f.reply(
        index,
        index === 1
          ? { error: { message: 'list rejected' } }
          : {
              result:
                index === 2
                  ? { data: [{ itemId: 'command', command: 5 }] }
                  : terminals(['command', 'eventual command']),
            },
      );

      assert.equal(f.commands().length, index === 3 ? 1 : 0);
    }

    assert.equal(
      f.events.filter(
        (event) =>
          event.type === 'notice' && event.text.includes('could not list'),
      ).length,
      2,
    );

    assert.deepEqual(
      f.commands().map(({ description, status }) => [description, status]),
      [['eventual command', 'running']],
    );
  } finally {
    await close(f.session, f.cwd);
  }
});

describe('closing or losing Codex clears brews and ignores pending discovery', () => {
  for (const loss of [false, true])
    test(loss ? 'process exit' : 'close', async () => {
      const f = await controlledFixture();

      try {
        const first = f.session.send('first');
        await appears(join(f.cwd, 'turn-1.json'));
        await f.emit(commandFrame('listed'), turnFrame());
        await first;
        await f.reply(1, { result: terminals(['listed', 'listed command']) });
        const second = f.session.send('second');
        await appears(join(f.cwd, 'turn-2.json'));
        await f.emit(commandFrame('pending', 'turn-2'), turnFrame('turn-2'));
        await second;
        await appears(join(f.cwd, 'list-2.json'));

        if (loss) {
          await writeFile(join(f.cwd, 'exit'), '');
          await until('the lost session', () => f.session.closed);
        } else {
          const third = f.session.send('third');
          await appears(join(f.cwd, 'turn-3.json'));
          const closing = f.session.close();
          await appears(join(f.cwd, 'interrupt.json'));
          await f.reply(2, { result: terminals(['pending', 'late command']) });
          await writeFile(join(f.cwd, 'allow-interrupt'), '');
          await within(closing, 2000, 'closing without discovery');
          await third;
        }

        assert.deepEqual(
          f.commands().map(({ description, status }) => [description, status]),
          [
            ['listed command', 'running'],
            ['listed command', 'stopped'],
          ],
        );

        assert.equal(
          f.events.some(
            (event) =>
              event.type === 'notice' && event.text.includes('could not list'),
          ),
          false,
        );
      } finally {
        await close(f.session, f.cwd);
      }
    });
});

for (const resume of [undefined, 'native-thread']) {
  test(`${resume ? 'resumed' : 'new'} threads receive current roots and load every model page without native overrides`, async () => {
    const { session, cwd } = await fixture(undefined, { resume });

    try {
      assert.deepEqual(
        (await session.models()).map((model) => [model.id, model.efforts]),
        [
          ['model-a', ['low']],
          ['model-b', ['high']],
        ],
      );

      const request = JSON.parse(
        await readFile(join(cwd, 'connect.json'), 'utf8'),
      );

      assert.equal(request.method, resume ? 'thread/resume' : 'thread/start');
      assert.equal(request.params.threadId, resume);

      assert.deepEqual(request.params.runtimeWorkspaceRoots, [
        cwd,
        '/shared/global',
        '/shared/project',
      ]);

      assert.deepEqual(request.params.config, {});

      for (const key of [
        'baseInstructions',
        'developerInstructions',
        'sandbox',
        'permissions',
        'approvalPolicy',
        'approvalsReviewer',
      ])
        assert.equal(request.params[key], undefined);
    } finally {
      await close(session, cwd);
    }
  });
}
