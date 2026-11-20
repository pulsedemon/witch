import { execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { z } from 'zod';
import { compactionThreshold } from '../../core/compaction-policy.js';
import { readConfig } from './config.js';
import { defaultModel } from './models.js';
import { nativeLaunch } from '../native-launch.js';
import { watchChild } from '../stderr.js';
import { stopDeadline, stopOptions, terminateChild } from '../shutdown.js';
import type { JsonRpc } from './json-rpc.js';
import type {
  ContextWindowChoice,
  Model,
  ModelDiscoveryOptions,
  SessionInfo,
  SessionOptions,
} from '../types.js';

export interface CodexSelection {
  model: string;
  effort?: string;
  contextWindow?: ContextWindowChoice;
}

const catalog = z.object({
  models: z.array(
    z.object({
      slug: z.string(),
      context_window: z.number().nullish(),
      max_context_window: z.number().nullish(),
      effective_context_window_percent: z.number(),
    }),
  ),
});

type ContextCatalog = z.infer<typeof catalog>;

type ContextModel = ContextCatalog['models'][number];

interface ThreadBase {
  cwd: string;
  runtimeWorkspaceRoots: string[];
  config: Record<string, unknown>;
}

function usableWindow(model: ContextModel, window: number): number {
  return Math.floor((window * model.effective_context_window_percent) / 100);
}

export function withContextWindows(
  models: Model[],
  context: ContextCatalog,
): Model[] {
  return models.map((model) => {
    const entry = context.models.find(({ slug }) => slug === model.id);

    if (!entry?.context_window || !entry.max_context_window) return model;

    return {
      ...model,
      contextWindows: {
        default: usableWindow(entry, entry.context_window),
        maximum: usableWindow(entry, entry.max_context_window),
      },
    };
  });
}

export async function readContextCatalog(
  options: ModelDiscoveryOptions,
  env = process.env,
) {
  let child: ChildProcess | undefined;
  let closed: Promise<void> | undefined;

  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      child = nativeLaunch(options.executable, env, (command) =>
        execFile(
          command,
          ['debug', 'models'],
          {
            cwd: options.cwd,
            signal: options.signal,
            env,
            maxBuffer: 8 * 1024 * 1024,
          },
          (error, output) => (error ? reject(error) : resolve(output)),
        ),
      );

      closed = watchChild(child).closed;
    });

    return catalog.parse(JSON.parse(stdout));
  } finally {
    if (child && closed)
      await terminateChild(
        child,
        closed,
        stopDeadline(stopOptions(options.signal)?.deadline),
      );
  }
}

export class CodexCompactionPolicy {
  private appliedWindow?: number;
  private appliedTarget?: number;

  private constructor(
    private readonly rpc: JsonRpc,
    private readonly options: SessionOptions,
    private readonly model: string | undefined,
    private readonly catalog: ContextCatalog,
    private readonly configuredWindow: unknown,
    private readonly base: ThreadBase,
  ) {
    this.appliedWindow = this.window();
    this.appliedTarget = this.target();
  }

  static async read(
    rpc: JsonRpc,
    options: SessionOptions,
    base: ThreadBase,
    read: typeof readContextCatalog,
  ): Promise<CodexCompactionPolicy | undefined> {
    if (!options.automaticCompaction) return;

    const models = await read(options);

    if (!models.models.length) return;

    const config = await readConfig(rpc, options.cwd);
    let model = options.model;

    if (!model && options.resume) {
      const saved = z
        .object({ thread: z.object({ model: z.string().nullish() }) })
        .parse(
          await rpc.request('thread/read', {
            threadId: options.resume,
            includeTurns: false,
          }),
        );

      model = saved.thread.model ?? undefined;
    } else if (!model && typeof config.model === 'string') model = config.model;

    if (!model && !options.resume) model = await defaultModel(rpc);

    return new CodexCompactionPolicy(
      rpc,
      options,
      model,
      models,
      config.model_context_window,
      base,
    );
  }

  models(models: Model[]): Model[] {
    return withContextWindows(models, this.catalog);
  }

  private window(
    model = this.model,
    choice = this.options.contextWindow,
  ): number | undefined {
    const entry = this.catalog.models.find(({ slug }) => slug === model);

    if (!entry) return;

    const requested =
      choice === 'default'
        ? entry.context_window
        : choice === 'maximum'
          ? entry.max_context_window
          : this.configuredWindow;

    return typeof requested === 'number'
      ? Math.min(requested, entry.max_context_window ?? requested)
      : (entry.context_window ?? entry.max_context_window ?? undefined);
  }

  capacity(
    model = this.model,
    choice = this.options.contextWindow,
  ): number | undefined {
    const entry = this.catalog.models.find(({ slug }) => slug === model);
    const window = this.window(model, choice);

    return entry && window !== undefined
      ? usableWindow(entry, window)
      : undefined;
  }

  private target(model = this.model, choice = this.options.contextWindow) {
    const window = this.capacity(model, choice);

    return window === undefined
      ? undefined
      : compactionThreshold(window).tokens;
  }

  configuration(
    model = this.model,
    choice = this.options.contextWindow,
  ): Record<string, unknown> {
    const target = this.target(model, choice);

    return target === undefined
      ? {}
      : {
          ...(choice && { model_context_window: this.window(model, choice) }),
          model_auto_compact_token_limit: target,
          model_auto_compact_token_limit_scope: 'total',
        };
  }

  assertIdle(
    model: string,
    busy: boolean,
    choice = this.options.contextWindow,
  ): void {
    if (this.requiresReload(model, choice) && busy)
      throw new Error(
        'Wait for Codex background work to finish before changing its compaction window.',
      );
  }

  requiresReload(model: string, choice?: ContextWindowChoice): boolean {
    return (
      this.window(model, choice) !== this.appliedWindow ||
      this.target(model, choice) !== this.appliedTarget
    );
  }

  async apply(
    info: SessionInfo,
    selection: CodexSelection,
    busy: boolean,
  ): Promise<unknown> {
    const { model, effort, contextWindow } = selection;

    if (!this.requiresReload(model, contextWindow)) return;

    this.assertIdle(model, busy, contextWindow);
    await this.rpc.request('thread/unsubscribe', { threadId: info.id });

    const response = await this.rpc.request(
      info.hasHistory ? 'thread/resume' : 'thread/start',
      {
        ...this.base,
        ...(!info.hasHistory ? { model } : {}),
        config: {
          ...this.base.config,
          ...this.configuration(model, contextWindow),
          ...(!info.hasHistory && effort
            ? { model_reasoning_effort: effort }
            : {}),
        },
        ...(info.hasHistory ? { threadId: info.id, excludeTurns: true } : {}),
      },
    );

    this.appliedWindow = this.window(model, contextWindow);
    this.appliedTarget = this.target(model, contextWindow);

    return response;
  }
}
