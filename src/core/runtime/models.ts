import type { AgentRegistration } from '../../agents/registry.js';
import { errorMessage } from '../../errors.js';
import type {
  AgentSession,
  ContextWindowChoice,
  Model,
} from '../../agents/types.js';
import type { Catalog } from './routing.js';

export interface ModelChoice extends Model {
  agent: string;
}

export type ModelSelection = Pick<ModelChoice, 'agent' | 'id'> & {
  effort?: string;
  contextWindow?: ContextWindowChoice;
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

/** an unprefixed ID goes to a runtime whose models or alias targets include it, preferring the active one; an unlisted ID stays on the active runtime as written. */
export function modelTarget(
  text: string,
  activeAgent: string,
  agentIds: readonly string[],
  catalog: Catalog,
): Pick<ModelSelection, 'agent' | 'id'> {
  const colon = text.indexOf(':');
  const agent = text.slice(0, colon);

  if (colon < 0 || !agentIds.includes(agent)) {
    const listed = [
      ...catalog.models
        .filter((model) => model.id === text)
        .map((model) => model.agent),
      ...Object.entries(catalog.latest)
        .filter(([, aliases]) => Object.values(aliases).includes(text))
        .map(([runtime]) => runtime),
    ];

    return {
      agent: listed.includes(activeAgent)
        ? activeAgent
        : (listed[0] ?? activeAgent),
      id: text,
    };
  }

  const id = text.slice(colon + 1);

  if (!id) throw new Error('Choose a model ID.');

  return { agent, id };
}

/** an alias read starts a CLI even beside a live session, so one that hasn't answered by then is stopped rather than holding the catalog. */
export const LATEST_READ_MS = 30_000;

/** an inactive runtime's list is kept until a refresh, so a connect doesn't start that CLI again; each runtime's latest models are kept the same way, whatever the directory. */
export class ModelCatalog {
  private discovery?: AbortController;
  private readonly lists = new Map<string, Model[]>();
  private readonly latestModels = new Map<string, Record<string, string>>();

  constructor(
    private readonly registrations: readonly AgentRegistration[],
    private readonly report: (error: unknown) => void,
  ) {}

  get availability() {
    return this.registrations.map(({ adapter, executable }) => ({
      id: adapter.id,
      label: adapter.label,
      installed: !!executable,
    }));
  }

  installed(id: string): AgentRegistration {
    const registration = this.registrations.find(
      ({ adapter }) => adapter.id === id,
    );

    if (!registration?.executable)
      throw new Error(
        `${registration?.adapter.label ?? id} is not installed. Run pnpm install in Witch's checkout, and sign in through its native CLI once.`,
      );

    return registration;
  }

  invalidate(runtime: string): void {
    for (const key of this.lists.keys())
      if (key.startsWith(`${runtime}:`)) this.lists.delete(key);

    this.latestModels.delete(runtime);
  }

  async read(
    cwd: string,
    active?: AgentSession,
    { refresh = false }: { refresh?: boolean } = {},
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
          const timeout = new AbortController();

          const timer = setTimeout(
            () => timeout.abort(new Error('the alias read timed out')),
            LATEST_READ_MS,
          );

          timer.unref();

          try {
            this.latestModels.set(
              adapter.id,
              await adapter.latest!({
                cwd,
                executable: executable!,
                signal: AbortSignal.any([discovery.signal, timeout.signal]),
              }),
            );
          } finally {
            clearTimeout(timer);
          }
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

  /** each runtime's family aliases and the concrete model each names, read past native pins; a runtime whose read hasn't succeeded has none, so routing can't run its aliases by name. */
  get latest(): Record<string, Record<string, string>> {
    return Object.fromEntries(
      this.registrations
        .filter(({ adapter, executable }) => executable && adapter.latest)
        .map(({ adapter }) => [
          adapter.id,
          this.latestModels.get(adapter.id) ?? {},
        ]),
    );
  }

  cancel(reason?: unknown): void {
    this.discovery?.abort(reason);
  }
}
