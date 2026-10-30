import type { AgentRegistration } from '../agents/registry.js';
import { errorMessage } from '../agents/stderr.js';
import type { AgentSession, Model } from '../agents/types.js';

export interface ModelChoice extends Model {
  agent: string;
}

export type ModelSelection = Pick<ModelChoice, 'agent' | 'id'> & {
  effort?: string;
};

export function modelEffort(
  selection: ModelSelection,
  models: readonly ModelChoice[],
  kept?: string,
): string | null | undefined {
  return models.some(
    (model) =>
      model.agent === selection.agent &&
      model.id === selection.id &&
      !model.efforts.length,
  )
    ? null
    : (selection.effort ?? kept);
}

export function modelKey(model: Pick<ModelChoice, 'agent' | 'id'>): string {
  return `${model.agent}:${model.id}`;
}

export function modelTarget(
  text: string,
  activeAgent: string,
  agentIds: readonly string[],
): Pick<ModelSelection, 'agent' | 'id'> {
  const colon = text.indexOf(':');
  const agent = text.slice(0, colon);
  if (colon < 0 || !agentIds.includes(agent))
    return { agent: activeAgent, id: text };
  const id = text.slice(colon + 1);
  if (!id) throw new Error('Choose a model ID.');
  return { agent, id };
}

/** an inactive runtime's list is kept until a refresh, so a connect doesn't start that CLI again; each runtime's latest models are kept the same way, whatever the directory. */
export class ModelCatalog {
  private discovery?: AbortController;
  private readonly lists = new Map<string, Model[]>();
  private readonly latestModels = new Map<string, Record<string, string>>();

  constructor(
    private readonly registrations: readonly AgentRegistration[],
    private readonly report: (error: unknown) => void,
  ) {}

  async read(
    cwd: string,
    active?: AgentSession,
    refresh = false,
  ): Promise<ModelChoice[]> {
    const discovery = new AbortController();
    this.discovery = discovery;
    const installed = this.registrations.filter(({ executable }) => executable);
    try {
      const latest = installed.filter(
        ({ adapter }) =>
          adapter.latest && (refresh || !this.latestModels.has(adapter.id)),
      );
      const latestReads = Promise.allSettled(
        latest.map(async ({ adapter, executable }) => {
          this.latestModels.set(
            adapter.id,
            await adapter.latest!({
              cwd,
              executable: executable!,
              signal: discovery.signal,
            }),
          );
        }),
      );
      const results = await Promise.allSettled(
        installed.map(async ({ adapter, executable }) => {
          let models: Model[] | undefined;
          if (active?.info.agent === adapter.id)
            models = await active.models(refresh);
          else {
            const key = `${adapter.id}:${cwd}`;
            if (!refresh) models = this.lists.get(key);
            models ??= await adapter.models({
              cwd,
              executable: executable!,
              signal: discovery.signal,
            });
            this.lists.set(key, models);
          }
          return models.map((model) => ({ ...model, agent: adapter.id }));
        }),
      );
      const latestResults = await latestReads;
      discovery.signal.throwIfAborted();
      const errors: string[] = [];
      const failed = (label: string, reason: unknown) =>
        errors.push(`${label}: ${errorMessage(reason)}`);
      const models = results.flatMap((result, index) => {
        if (result.status === 'fulfilled') return result.value;
        failed(installed[index]!.adapter.label, result.reason);
        return [];
      });
      latestResults.forEach((result, index) => {
        if (result.status === 'rejected')
          failed(latest[index]!.adapter.label, result.reason);
      });
      if (errors.length) this.report(new Error(errors.join('\n')));
      return models;
    } finally {
      this.discovery = undefined;
    }
  }

  /** each runtime's family aliases and the concrete model each names, read past native pins. */
  get latest(): Record<string, Record<string, string>> {
    return Object.fromEntries(this.latestModels);
  }

  cancel(reason?: unknown): void {
    this.discovery?.abort(reason);
  }
}
