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

export class ModelCatalog {
  private discovery?: AbortController;

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
      const results = await Promise.allSettled(
        installed.map(async ({ adapter, executable }) => {
          const models =
            active?.info.agent === adapter.id
              ? await active.models(refresh)
              : await adapter.models({
                  cwd,
                  executable: executable!,
                  signal: discovery.signal,
                });
          return models.map((model) => ({ ...model, agent: adapter.id }));
        }),
      );
      discovery.signal.throwIfAborted();
      return results.flatMap((result, index) => {
        if (result.status === 'fulfilled') return result.value;
        this.report(
          new Error(
            `${installed[index]!.adapter.label}: ${errorMessage(result.reason)}`,
          ),
        );
        return [];
      });
    } finally {
      this.discovery = undefined;
    }
  }

  cancel(): void {
    this.discovery?.abort();
  }
}
