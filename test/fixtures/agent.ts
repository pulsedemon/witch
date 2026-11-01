import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentAdapter,
  AgentSession,
  AgentStopOptions,
  AnswerInput,
  AccountReading,
  Model,
  ModelDiscoveryOptions,
  SessionInfo,
  SessionOptions,
  Skill,
  SkillCall,
  TurnResult,
  Usage,
  UserResponse,
} from '../../src/agents/types.js';
import { peerRequestSchema } from '../../src/core/peer-requests.js';
import type { PeerRequest } from '../../src/core/peer-requests.js';

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
  readonly inputs: {
    session: string;
    prompt: string;
    context?: string;
    skill?: SkillCall;
    author?: 'witch';
    answer?: AnswerInput;
  }[] = [];
  /** prompts steered into a turn in flight. */
  readonly steers: string[] = [];
  readonly contextSteers: string[] = [];
  /** the calls of the spells and native commands sessions took as steers. */
  readonly skillSteers: SkillCall[] = [];
  /** the `!` commands sessions ran. */
  readonly shells: string[] = [];
  readonly compactions: string[] = [];
  /** a gated command finishes as the interrupt lands, as a fast one can. */
  finishShellOnInterrupt = false;
  /** an interrupt reports the turn's steered prompts unread, as Claude Code does for those it still holds. */
  unreadOnInterrupt = false;
  /** the turn in flight refuses steered prompts, as Codex refuses one for a turn that has just ended. */
  refuseSteer = false;
  /** the turn in flight refuses a steered spell or native command, as Codex does. */
  refuseSkillSteer = false;
  /** the turn in flight has replied and a familiar holds it open, as Claude's does. */
  replied = false;
  /** what each session's `skills()` returns. */
  skills: Skill[] = [];
  failSkills = false;
  readonly sessions: { options: SessionOptions; session: AgentSession }[] = [];
  readonly selections: [string, string | null | undefined][] = [];
  readonly responses: [string, UserResponse][] = [];
  readonly stops: {
    operation: 'interrupt' | 'close';
    options?: AgentStopOptions;
  }[] = [];
  failConnect = false;
  /** the next `models()` rejects, as a failed Codex `model/list` does. */
  failModels = false;
  failDiscovery = false;
  readonly discoveries: ModelDiscoveryOptions[] = [];
  readonly catalog: Model[];
  /** an effort connect and selectModel reject, as Claude Code rejects one outside its levels. */
  invalidEffort?: string;
  failClose = false;
  failInterrupt = false;
  interruptNext = false;
  /** the next turn fails once its gate opens, as a native error ends one. */
  failNext = false;
  /** a turn whose prompt it matches fails once its gate opens, with confirmed usage exhaustion. */
  exhaust?: (prompt: string) => boolean;
  peerReply?: (requests: PeerRequest[]) => string;
  gate?: TurnGate;
  /** what a session reports as its usage when it connects. */
  connectUsage?: Usage;
  /** a usage event the session sends while it lists its models. */
  modelsUsage?: Usage;
  /** skills the session changes to while it lists its models, as an event and in what `skills()` returns. */
  modelsSkills?: Skill[];
  /** what a completed turn reports as its session's usage. */
  turnUsage?: Usage;
  /** runs before a connect does anything else. */
  beforeConnect?: (options: SessionOptions) => Promise<void>;
  /** runs as each turn is sent, after its input is recorded, as an agent's edits during the turn would. */
  onSend?: (prompt: string) => Promise<void>;
  /** account reads are kept apart from model discovery. */
  accountReading: AccountReading = { limits: [] };
  accountRead?: (
    options: ModelDiscoveryOptions,
    previous: AccountReading,
  ) => Promise<AccountReading>;
  readonly accountReads: ModelDiscoveryOptions[] = [];
  /** set to give the runtime family aliases, as Claude's adapter has. */
  latest?: (options: ModelDiscoveryOptions) => Promise<Record<string, string>>;

  constructor(readonly id: string) {
    this.label = id;
    this.catalog = [
      { id: `${id}-model`, label: `${id}-model`, efforts: [] },
      { id: `${id}-big`, label: `${id}-big`, efforts: ['high'] },
    ];
  }

  async models(options: ModelDiscoveryOptions): Promise<Model[]> {
    this.discoveries.push(options);
    options.signal?.throwIfAborted();
    if (this.failDiscovery) throw new Error('Discovery failed');
    return this.catalog;
  }

  async accountUsage(
    options: ModelDiscoveryOptions,
    previous: AccountReading,
  ): Promise<AccountReading> {
    this.accountReads.push(options);
    options.signal?.throwIfAborted();
    return this.accountRead
      ? this.accountRead(options, previous)
      : this.accountReading;
  }

  async connect(options: SessionOptions): Promise<AgentSession> {
    await this.beforeConnect?.(options);
    if (this.failConnect) throw new Error('Destination unavailable');
    if (options.effort && options.effort === this.invalidEffort)
      throw new Error('Invalid effort');
    let info: SessionInfo = {
      id: options.resume ?? randomUUID(),
      agent: this.id,
      model: options.model ?? `${this.id}-model`,
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
    // apart from `turn`, so steering is refused while a command runs, as the real agents refuse it
    let shell: PromiseWithResolvers<TurnResult> | undefined;
    let steered: string[] = [];
    let usage: Usage = this.connectUsage ?? {};
    const replied = () => this.replied && !!turn && !closed;
    const shellRow = (command: string) =>
      options.onEvent({
        type: 'tool',
        id: randomUUID(),
        title: command,
        text: `ran ${command}\n`,
        done: true,
        shell: true,
      });
    const session: AgentSession = {
      get info() {
        return info;
      },
      get usage() {
        return usage;
      },
      get closed() {
        return closed;
      },
      get replied() {
        return replied();
      },
      contextUsage: async () => usage.context,
      compact: async () => {
        if (closed) throw new Error('Session closed');
        this.compactions.push(info.id);
        turn = Promise.withResolvers<TurnResult>();
        const held = this.gate ? await this.gate.hold(turn.promise) : undefined;
        turn = undefined;
        if (held) return held;
        if (this.failNext) {
          this.failNext = false;
          return { status: 'failed', text: '', error: 'Compaction failed' };
        }
        options.onEvent({ type: 'compacted' });
        return { status: 'completed', text: '' };
      },
      skills: async () => {
        if (this.failSkills) throw new Error('Skills unavailable');
        return this.skills;
      },
      models: async () => {
        if (this.failModels) {
          this.failModels = false;
          throw new Error('model/list failed');
        }
        if (this.modelsSkills) {
          this.skills = this.modelsSkills;
          options.onEvent({ type: 'skills', skills: this.skills });
        }
        if (this.modelsUsage) {
          usage = this.modelsUsage;
          options.onEvent({ type: 'usage', usage });
        }
        return this.catalog;
      },
      selectModel: async (model, effort) => {
        if (effort && effort === this.invalidEffort)
          throw new Error('Invalid effort');
        this.selections.push([model, effort]);
        info = {
          ...info,
          model,
          effort: effort === undefined ? info.effort : (effort ?? undefined),
        };
      },
      respond: (id, response) => {
        this.responses.push([id, response]);
      },
      shell: async (command): Promise<TurnResult> => {
        if (closed) throw new Error('Session closed');
        this.shells.push(command);
        shellRow(command);
        shell = Promise.withResolvers<TurnResult>();
        const held = this.gate
          ? await this.gate.hold(shell.promise)
          : undefined;
        shell = undefined;
        if (held) return held;
        if (this.failNext) {
          this.failNext = false;
          return { status: 'failed', text: '', error: 'Overloaded' };
        }
        return { status: 'completed', text: '' };
      },
      steer: async (prompt, { command, skill, contextOnly } = {}) => {
        if (
          !turn ||
          closed ||
          this.refuseSteer ||
          (skill && this.refuseSkillSteer)
        )
          return false;
        (contextOnly ? this.contextSteers : this.steers).push(prompt);
        if (skill) this.skillSteers.push(skill);
        if (command === undefined) {
          if (!contextOnly) steered.push(prompt);
        } else {
          this.shells.push(command);
          shellRow(command);
        }
        return true;
      },
      interrupt: async (options) => {
        this.stops.push({ operation: 'interrupt', options });
        if (this.failInterrupt) throw new Error('Interrupt failed');
        shell?.resolve({
          status: this.finishShellOnInterrupt ? 'completed' : 'interrupted',
          text: '',
        });
        turn?.resolve({
          status: 'interrupted',
          text: '',
          ...(this.unreadOnInterrupt ? { unread: steered } : {}),
        });
      },
      close: async (stop) => {
        this.stops.push({ operation: 'close', options: stop });
        closed = true;
        turn?.resolve({ status: 'failed', text: '', error: 'Session closed' });
        try {
          if (this.failClose) throw new Error('Close failed');
        } finally {
          sleeper.kill();
          await options.onProcess(undefined);
        }
      },
      send: async (
        prompt,
        skill,
        context,
        purpose = 'user',
        answer,
      ): Promise<TurnResult> => {
        if (closed) throw new Error('Session closed');
        this.inputs.push({
          session: info.id,
          prompt,
          ...(context === undefined ? {} : { context }),
          ...(skill ? { skill } : {}),
          ...(purpose === 'user' ? {} : { author: 'witch' as const }),
          ...(answer ? { answer } : {}),
        });
        if (this.onSend) await this.onSend(prompt);
        // MEMORY.md merges both sides, so a note that can conflict goes elsewhere
        const note = /remember:(\S+)/.exec(prompt)?.[1];
        if (note)
          await writeFile(
            join(options.memoryDirectories[1]!, 'notes.md'),
            note,
          );
        if (prompt.includes('remember-port'))
          await writeFile(
            join(options.memoryDirectories[1]!, 'MEMORY.md'),
            'Use port 4567.',
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
        steered = [];
        const held = this.gate ? await this.gate.hold(turn.promise) : undefined;
        turn = undefined;
        let result = held;
        if (!result && this.failNext) {
          this.failNext = false;
          result = { status: 'failed', text: '', error: 'Overloaded' };
        }
        if (!result && this.exhaust?.(prompt))
          result = {
            status: 'failed',
            text: '',
            error: 'Usage limit reached',
            exhausted: true,
          };
        if (!result) {
          let text = prompt.includes('handoff summary')
            ? `${this.id}: finish the migration`
            : 'Done.';
          if (purpose === 'peer-answer') {
            const path = /Read their messages from ("(?:[^"\\]|\\.)*")/.exec(
              context ?? '',
            )?.[1];
            if (!path) throw new Error('Missing peer request file');
            const requests = peerRequestSchema
              .array()
              .parse(
                JSON.parse(await readFile(JSON.parse(path) as string, 'utf8')),
              );
            text =
              this.peerReply?.(requests) ??
              JSON.stringify({
                answers: requests.map(({ id }) => ({ id, message: 'Done.' })),
              });
          } else options.onEvent({ type: 'text', id: randomUUID(), text });
          if (this.turnUsage) {
            usage = this.turnUsage;
            options.onEvent({ type: 'usage', usage });
          }
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
