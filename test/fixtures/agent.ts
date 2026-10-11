import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
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
  failConnect = false;
  failClose = false;
  interruptNext = false;
  gate?: TurnGate;

  constructor(readonly id: string) {
    this.label = id;
  }

  async connect(options: SessionOptions): Promise<AgentSession> {
    if (this.failConnect) throw new Error('Destination unavailable');
    this.resumed.push(options.resume);
    const info: SessionInfo = {
      id: options.resume ?? randomUUID(),
      agent: this.id,
      cwd: options.cwd,
      model: `${this.id}-model`,
      permissionMode: 'default',
      hasHistory: true,
    };
    options.onEvent({ type: 'info', info });
    // a bounded stand-in for the native process, never the test runner's pid
    const sleeper = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    sleeper.unref();
    await options.onProcess(sleeper.pid);
    let closed = false;
    let turn: PromiseWithResolvers<TurnResult> | undefined;
    const session: AgentSession = {
      info,
      get closed() {
        return closed;
      },
      models: async () => [
        { id: info.model, label: info.model, description: '', efforts: [] },
      ],
      selectModel: async () => {},
      respond: () => {},
      interrupt: async () => {
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
