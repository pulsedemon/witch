import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentAdapter,
  AgentSession,
  SessionInfo,
  SessionOptions,
  TurnResult,
} from '../../src/agents/types.js';

/** holds gated turns until `open()`, which releases the current turn and every later one. */
export class TurnGate {
  private readonly opening = Promise.withResolvers<void>();
  private readonly entering = Promise.withResolvers<void>();
  private readonly finishing = Promise.withResolvers<TurnResult>();
  /** resolves once a gated turn has entered. */
  readonly entered = this.entering.promise;
  /** the first gated turn's result. */
  readonly result = this.finishing.promise;

  open(): void {
    this.opening.resolve();
  }

  async hold(ended: Promise<TurnResult>): Promise<TurnResult | undefined> {
    this.entering.resolve();
    return Promise.race([this.opening.promise.then(() => undefined), ended]);
  }

  finish(result: TurnResult): void {
    this.finishing.resolve(result);
  }
}

/** an in-process agent that reports a process and ends turns the way the real adapters do. */
export class FixtureAgent implements AgentAdapter {
  readonly label: string;
  readonly inputs: { session: string; prompt: string }[] = [];
  readonly resumed: (string | undefined)[] = [];
  readonly sessions: { options: SessionOptions; session: AgentSession }[] = [];
  readonly selections: [string, string | null | undefined][] = [];
  failConnect = false;
  failClose = false;
  failInterrupt = false;
  interruptNext = false;
  gate?: TurnGate;
  /** runs before a connect does anything else. */
  beforeConnect?: (options: SessionOptions) => Promise<void>;

  constructor(readonly id: string) {
    this.label = id;
  }

  async connect(options: SessionOptions): Promise<AgentSession> {
    await this.beforeConnect?.(options);
    if (this.failConnect) throw new Error('Destination unavailable');
    this.resumed.push(options.resume);
    let info: SessionInfo = {
      id: options.resume ?? randomUUID(),
      agent: this.id,
      cwd: options.cwd,
      model: `${this.id}-model`,
      permissionMode: 'default',
      hasHistory: true,
      effort: options.effort,
    };
    options.onEvent({ type: 'info', info });
    // a bounded stand-in for the native process, never the test runner's pid
    const sleeper = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    sleeper.unref();
    await options.onProcess(sleeper.pid);
    let closed = false;
    let turn: PromiseWithResolvers<TurnResult> | undefined;
    const session: AgentSession = {
      get info() {
        return info;
      },
      get closed() {
        return closed;
      },
      models: async () => [
        {
          id: `${this.id}-model`,
          label: `${this.id}-model`,
          description: '',
          efforts: [],
        },
      ],
      selectModel: async (model, effort) => {
        this.selections.push([model, effort]);
        info = {
          ...info,
          model,
          effort: effort === undefined ? info.effort : (effort ?? undefined),
        };
      },
      respond: () => {},
      interrupt: async () => {
        if (this.failInterrupt) throw new Error('Interrupt failed');
        turn?.resolve({ status: 'interrupted', text: '' });
      },
      close: async () => {
        closed = true;
        turn?.resolve({ status: 'failed', text: '', error: 'Session closed' });
        try {
          if (this.failClose) throw new Error('Close failed');
        } finally {
          sleeper.kill();
          await options.onProcess(undefined);
        }
      },
      send: async (prompt): Promise<TurnResult> => {
        if (closed) throw new Error('Session closed');
        this.inputs.push({ session: info.id, prompt });
        const note =
          /remember:(\S+)/.exec(prompt)?.[1] ??
          (prompt.includes('remember-port') ? 'Use port 4567.' : undefined);
        if (note)
          await writeFile(
            join(options.memoryDirectories[1]!, 'MEMORY.md'),
            note,
          );
        if (prompt.includes('symlink-note'))
          await symlink(
            tmpdir(),
            join(options.memoryDirectories[1]!, 'linked.md'),
          );
        if (this.interruptNext) {
          this.interruptNext = false;
          return { status: 'interrupted', text: '' };
        }
        turn = Promise.withResolvers<TurnResult>();
        const held = this.gate ? await this.gate.hold(turn.promise) : undefined;
        turn = undefined;
        let result = held;
        if (!result) {
          const text = prompt.includes('handoff summary')
            ? `${this.id}: finish the migration`
            : 'Done.';
          options.onEvent({ type: 'text', id: randomUUID(), text });
          result = { status: 'completed', text };
        }
        this.gate?.finish(result);
        return result;
      },
    };
    this.sessions.push({ options, session });
    return session;
  }
}
