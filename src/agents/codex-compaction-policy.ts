import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { compactionThreshold } from '../core/compaction-policy.js';
import { readConfig } from './codex-answer.js';
import type { JsonRpc } from './json-rpc.js';
import type {
  ModelDiscoveryOptions,
  SessionInfo,
  SessionOptions,
} from './types.js';

export interface CodexSelection {
  model: string;
  effort?: string;
}

const execute = promisify(execFile);
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

export async function readContextCatalog(
  options: ModelDiscoveryOptions,
  env = process.env,
) {
  const { stdout } = await execute(options.executable, ['debug', 'models'], {
    cwd: options.cwd,
    signal: options.signal,
    env,
    maxBuffer: 8 * 1024 * 1024,
  });
  return catalog.parse(JSON.parse(stdout));
}

export class CodexCompactionPolicy {
  applied?: number;

  private constructor(
    private readonly rpc: JsonRpc,
    private readonly options: SessionOptions,
    readonly model: string | undefined,
    private readonly windows: ReadonlyMap<string, number>,
    private readonly baseConfiguration: Record<string, unknown>,
  ) {
    this.applied = this.target();
  }

  static async read(
    rpc: JsonRpc,
    options: SessionOptions,
    baseConfiguration: Record<string, unknown>,
    read = readContextCatalog,
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
    if (!model && !options.resume) {
      const page = z
        .object({
          data: z.array(z.object({ id: z.string(), isDefault: z.boolean() })),
        })
        .parse(await rpc.request('model/list', { cursor: null, limit: 100 }));
      model = page.data.find((entry) => entry.isDefault)?.id;
    }
    const windows = new Map<string, number>();
    for (const entry of models.models) {
      const requested = config.model_context_window;
      const window =
        typeof requested === 'number'
          ? Math.min(requested, entry.max_context_window ?? requested)
          : (entry.context_window ?? entry.max_context_window);
      if (window === undefined || window === null) continue;
      const usable = Math.floor(
        (window * entry.effective_context_window_percent) / 100,
      );
      if (usable > 0) windows.set(entry.slug, usable);
    }
    return new CodexCompactionPolicy(
      rpc,
      options,
      model,
      windows,
      baseConfiguration,
    );
  }

  target(model = this.model): number | undefined {
    const window = model === undefined ? undefined : this.windows.get(model);
    return window === undefined
      ? undefined
      : compactionThreshold(window).tokens;
  }

  configuration(model = this.model): Record<string, unknown> {
    const target = this.target(model);
    return target === undefined
      ? {}
      : {
          model_auto_compact_token_limit: target,
          model_auto_compact_token_limit_scope: 'total',
        };
  }

  assertIdle(model: string, busy: boolean): void {
    const target = this.target(model);
    if (target !== undefined && target !== this.applied && busy)
      throw new Error(
        'Wait for Codex background work to finish before changing its compaction window.',
      );
  }

  async apply(
    info: SessionInfo,
    selection: CodexSelection,
    busy: boolean,
  ): Promise<unknown> {
    const { model, effort } = selection;
    const target = this.target(model);
    if (target === undefined || target === this.applied) return;
    this.assertIdle(model, busy);
    await this.rpc.request('thread/unsubscribe', { threadId: info.id });
    const response = await this.rpc.request(
      info.hasHistory ? 'thread/resume' : 'thread/start',
      {
        cwd: this.options.cwd,
        ...(!info.hasHistory ? { model } : {}),
        runtimeWorkspaceRoots: [
          ...new Set([this.options.cwd, ...this.options.memoryDirectories]),
        ],
        config: {
          ...this.baseConfiguration,
          ...this.configuration(model),
          ...(!info.hasHistory && effort
            ? { model_reasoning_effort: effort }
            : {}),
        },
        ...(info.hasHistory ? { threadId: info.id, excludeTurns: true } : {}),
      },
    );
    this.applied = target;
    return response;
  }
}
