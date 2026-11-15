import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import type { AgentEvent } from '../../../src/agents/types.js';
import { CommandBatches } from '../../../src/ui/commands/command-batches.js';
import { Coordinator } from '../../../src/core/coordinator.js';
import { Workspace } from '../../../src/memory/workspace.js';
import {
  ConversationStore,
  StateStore,
} from '../../../src/persistence/store.js';
import { orderedCleanup } from '../../fixtures/cleanup.js';
import {
  coordinationFixture,
  unitCoordinationFixture,
  pauseDiscovery,
} from '../../fixtures/coordination.js';
import { FixtureAgent } from '../../fixtures/agent.js';
import {
  launcher,
  frameWriter,
  jsonLines,
} from '../../fixtures/claude-adapter.js';
import { seededMemory } from '../../fixtures/seeded-memory.js';
import { scratch } from '../../fixtures/scratch.js';
import { until, within } from '../../fixtures/within.js';

for (const timing of ['queued', 'waiting', 'late', 'exit'] as const)
  test(`native background exhaustion preserves input with ${timing} delivery`, async () => {
    const waiting = timing !== 'queued';
    const root = await scratch('witch-background-exhaustion-');
    const project = join(root, 'project');
    await mkdir(project);
    const store = await StateStore.open(join(root, 'state'));
    const memory = await seededMemory(join(root, 'memory.git'));
    const source = await launcher('background');
    const events: AgentEvent[] = [];
    const connect = source.adapter.connect.bind(source.adapter);

    vi.spyOn(source.adapter, 'connect').mockImplementation((options) =>
      connect({
        ...options,
        onEvent: (event) => {
          events.push(event);
          options.onEvent(event);
        },
      }),
    );

    const codex = new FixtureAgent('codex');

    codex.catalog.splice(0, Infinity, {
      id: 'gpt-6-astra',
      label: 'Astra',
      efforts: [],
    });

    codex.accountRead = async () => ({
      limits: [{ window: '7D', percent: 10, observedAt: Date.now() }],
    });

    const coordinator = new Coordinator(store, memory, [
      { adapter: source.adapter, executable: '/fake/claude' },
      { adapter: codex, executable: 'codex' },
    ]);

    try {
      await coordinator.initialize(project);

      await coordinator.selectModel({
        agent: 'claude',
        id: 'claude-fable-5-2',
      });

      const emit = frameWriter(
        source.cwd,
        (name) =>
          events.some(
            (event) =>
              event.type === 'skills' && event.skills[0]?.name === name,
          ),
        source.children[0]!,
      );

      const initial = coordinator.send('Review the database change');

      await until('initial native result', () =>
        events.some(
          (event) =>
            event.type === 'skills' && event.skills[0]?.name === 'result-1',
        ),
      );

      await emit({
        type: 'system',
        subtype: 'session_state_changed',
        state: 'idle',
      });

      await initial;

      if (timing !== 'late')
        await emit({
          type: 'system',
          subtype: 'session_state_changed',
          state: 'running',
        });

      const sent = waiting ? coordinator.send('Queued follow-up') : undefined;

      if (waiting)
        await until(
          'input waiting behind native work',
          async () =>
            (await jsonLines(join(source.cwd, 'inputs.jsonl'))).length === 2,
        );

      if (timing === 'late')
        await emit({
          type: 'system',
          subtype: 'session_state_changed',
          state: 'running',
        });

      await emit(
        {
          type: 'rate_limit_event',
          rate_limit_info: {
            status: 'rejected',
            rateLimitType: 'seven_day',
            resetsAt: Date.now() / 1000 + 3600,
          },
        },
        ...(timing === 'exit'
          ? []
          : [
              {
                type: 'result',
                is_error: true,
                result: 'Usage limit reached',
                user_message_uuids: [],
              },
            ]),
      );

      if (timing === 'exit') {
        source.children[0]!.kill();
        await within(sent!, 5000, 'native exit with uncertain input');
        assert.equal(codex.inputs.length, 0);

        assert.ok(
          coordinator.snapshot.items.some(
            (item) =>
              item.kind === 'notice' &&
              item.text.includes('consumption could not be verified'),
          ),
        );

        assert.equal(coordinator.snapshot.conversation!.agent, 'claude');

        return;
      }

      if (!waiting) {
        await coordinator.send('Queued follow-up');

        await emit({
          type: 'system',
          subtype: 'session_state_changed',
          state: 'idle',
        });
      }

      if (sent) await within(sent, 5000, 'waiting send recovery');

      await until(
        'native background continuation',
        () =>
          coordinator.snapshot.conversation!.agent === 'codex' &&
          coordinator.snapshot.phase === 'idle' &&
          codex.inputs.length === 2,
      );

      assert.equal(
        coordinator.snapshot.conversation!.sessions.codex!.model,
        'gpt-6-astra',
      );

      assert.match(codex.inputs[0]!.prompt, /^Continue the task/);

      assert.match(
        codex.inputs[0]!.context!,
        /User: Review the database change/,
      );

      assert.ok(!codex.inputs[0]!.context!.includes('User: Queued follow-up'));
      assert.equal(codex.inputs[1]!.prompt, 'Queued follow-up');

      assert.equal(
        (await jsonLines(join(source.cwd, 'inputs.jsonl'))).length,
        waiting ? 2 : 1,
      );
    } finally {
      await coordinator.close();
    }
  });

for (const [stage, writesMemory, finishes] of [
  ['refresh', true, true],
  ['save', false, true],
  ['connection', true, true],
  ['quiescence', true, true],
  ['quiescence', false, false],
  ['quiescence-microtask', false, false],
  ['quiescence-microtask', false, true],
] as const)
  test(`${finishes ? 'completed' : 'running'} background work during ${stage} retains its context and continuation`, async (t) => {
    pauseDiscovery(vi.spyOn);
    const f = await coordinationFixture(orderedCleanup(t.onTestFinished));
    const claude = new FixtureAgent('claude');
    const codex = new FixtureAgent('codex');

    claude.catalog.splice(0, Infinity, {
      id: 'claude-fable-5-2',
      label: 'Fable',
      efforts: [],
    });

    codex.catalog.splice(0, Infinity, {
      id: 'gpt-6-astra',
      label: 'Astra',
      efforts: [],
    });

    const reading = async () => ({
      limits: [{ window: '7D', percent: 10, observedAt: Date.now() }],
    });

    for (const adapter of [claude, codex]) adapter.accountRead = reading;

    const { coordinator, coordination } = await f.start(
      'A',
      {},
      [claude, codex].map((adapter) => ({ adapter, executable: adapter.id })),
    );

    await coordinator.selectModel({ agent: 'claude', id: 'claude-fable-5-2' });
    await coordinator.send('Review migration');
    const source = claude.sessions.at(-1)!;
    const emit = source.options.onEvent;
    const binding = coordination.familiarBinding();
    let restarted = false;

    const report = () =>
      emit({
        type: 'subagent',
        subagent: {
          id: 'late',
          name: 'late review',
          kind: 'review',
          status: 'completed',
          report: 'Retain the migration lock.',
        },
      });

    const restart = async () => {
      if (restarted) return;

      restarted = true;
      emit({ type: 'running', running: true });

      emit({
        type: 'subagent',
        subagent: {
          id: 'late',
          name: 'late review',
          kind: 'review',
          status: 'running',
        },
      });

      if (writesMemory)
        await writeFile(
          join(source.options.memoryDirectories[1]!, 'background.md'),
          'Pending background notes.',
        );

      if (finishes) {
        report();
        emit({ type: 'running', running: false });
      }
    };

    if (stage === 'refresh')
      codex.accountRead = async () => {
        await restart();

        return reading();
      };

    if (stage === 'save') {
      const save = ConversationStore.prototype.save;

      vi.spyOn(ConversationStore.prototype, 'save').mockImplementation(
        async function (this: ConversationStore, record) {
          await save.call(this, record);

          if (record.handoff?.to === 'codex' && !record.handoff.activated)
            await restart();
        },
      );
    }

    if (stage === 'connection') {
      const scope = Workspace.prototype.scope;

      vi.spyOn(Workspace.prototype, 'scope').mockImplementation(async function (
        this: Workspace,
        cwd,
      ) {
        const result = await scope.call(this, cwd);

        if (coordinator.snapshot.conversation?.handoff?.to === 'codex')
          await restart();

        return result;
      });
    }

    if (stage.startsWith('quiescence')) {
      const quiesce = coordination.quiesce.bind(coordination);

      vi.spyOn(coordination, 'quiesce').mockImplementation(async () => {
        const restore = await quiesce();

        if (stage === 'quiescence-microtask')
          queueMicrotask(() => void restart());
        else await restart();

        return restore;
      });
    }

    emit({ type: 'running', running: true });
    emit({ type: 'exhausted' });
    await coordinator.send('Queued after report');
    emit({ type: 'running', running: false });

    if (writesMemory || !finishes) {
      await until(
        'source retained after intervening activity',
        () =>
          restarted &&
          coordinator.snapshot.phase === (writesMemory ? 'recovery' : 'idle'),
      );

      assert.equal(coordinator.snapshot.conversation!.agent, 'claude');
      assert.equal(source.session.closed, false);
      assert.equal(codex.inputs.length, 0);
      assert.deepEqual(coordination.familiarBinding(), binding);

      if (writesMemory) {
        assert.match(
          coordinator.snapshot.recovery!.diff,
          /Pending background notes/,
        );

        await coordinator.recoverMemory('discard');
      } else {
        emit({ type: 'running', running: false });
        report();
      }
    }

    await until(
      'continuation with late report',
      () => codex.inputs.length === 2 && coordinator.snapshot.phase === 'idle',
    );

    assert.match(codex.inputs[0]!.prompt, /^Continue the task/);
    assert.match(codex.inputs[0]!.context!, /Retain the migration lock/);
    assert.equal(codex.inputs[1]!.prompt, 'Queued after report');
    assert.equal(claude.inputs.length, 1);
  });

for (const mode of [
  'direct-blocked',
  'command-blocked',
  'command',
  'mixed',
  'queued',
] as const)
  test(`background exhaustion with ${mode} compaction preserves delivery holds`, async (t) => {
    pauseDiscovery(vi.spyOn);
    const f = await unitCoordinationFixture(orderedCleanup(t.onTestFinished));
    const claude = new FixtureAgent('claude');
    const codex = new FixtureAgent('codex');

    claude.catalog.splice(0, Infinity, {
      id: 'claude-fable-5-2',
      label: 'Fable',
      efforts: [],
    });

    codex.catalog.splice(0, Infinity, {
      id: 'gpt-6-astra',
      label: 'Astra',
      efforts: [],
    });

    for (const adapter of [claude, codex])
      adapter.accountRead = async () => ({
        limits: [
          {
            window: '7D',
            percent: adapter === codex && mode.endsWith('blocked') ? 100 : 10,
            observedAt: Date.now(),
          },
        ],
      });

    const { coordinator } = await f.start(
      'A',
      {},
      [claude, codex].map((adapter) => ({ adapter, executable: adapter.id })),
    );

    await coordinator.selectModel({ agent: 'claude', id: 'claude-fable-5-2' });
    await coordinator.send('Review migration');
    const emit = claude.sessions.at(-1)!.options.onEvent;
    const batches = new CommandBatches(coordinator);

    try {
      emit({ type: 'running', running: true });
      emit({ type: 'exhausted' });
      await coordinator.send('Queued after compact');
      const finished = Promise.withResolvers<boolean>();
      let compacting: Promise<boolean>;

      if (mode === 'direct-blocked') compacting = coordinator.compact();
      else {
        batches.submit(
          [
            { name: 'compact', argument: '' },
            ...(mode === 'mixed'
              ? [{ name: 'help' as const, argument: '' }]
              : []),
          ],
          async (command) => {
            if (command.name !== 'compact') return true;

            const result = await coordinator.compact();
            finished.resolve(result);

            return result;
          },
        );

        if (mode === 'queued')
          batches.submit([{ name: 'help', argument: '' }], async () => true);

        compacting = finished.promise;
      }

      emit({ type: 'running', running: false });
      const success = await within(compacting, 5000, 'background compaction');
      assert.equal(success, mode === 'command');

      await until(
        'compaction command settled',
        () =>
          !batches.pending &&
          coordinator.snapshot.phase === 'idle' &&
          (!success || codex.inputs.length === 2),
      );

      assert.equal(claude.compactions.length, 0);
      assert.equal(claude.inputs.length, 1);

      if (success) {
        assert.equal(codex.compactions.length, 1);
        assert.match(codex.inputs[0]!.prompt, /^Continue the task/);
        assert.equal(codex.inputs[1]!.prompt, 'Queued after compact');
      } else {
        assert.equal(codex.inputs.length, 0);
        assert.equal(codex.compactions.length, 0);
        assert.deepEqual(coordinator.snapshot.queue, ['Queued after compact']);

        if (mode === 'mixed' || mode === 'queued')
          assert.ok(
            coordinator.snapshot.items.some(
              (item) =>
                item.kind === 'notice' &&
                item.text.includes('commands are pending'),
            ),
          );
      }
    } finally {
      batches.close();
    }
  });
