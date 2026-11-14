import { z } from 'zod';
import { pages } from './json-rpc.js';
import type { JsonRpc } from './json-rpc.js';
import type { Model } from '../types.js';

const modelPage = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      displayName: z.string(),
      supportedReasoningEfforts: z.array(
        z.object({ reasoningEffort: z.string() }),
      ),
    }),
  ),
  nextCursor: z.string().nullable(),
});

/** hidden models run but stay out of Codex's own picker. */
export async function readModels(
  rpc: JsonRpc,
  includeHidden?: true,
): Promise<Model[]> {
  const models: Model[] = [];

  for await (const data of pages(
    rpc,
    'model/list',
    { cursor: null, limit: 100, ...(includeHidden && { includeHidden }) },
    modelPage,
  ))
    models.push(
      ...data.map((model) => ({
        id: model.id,
        label: model.displayName,
        efforts: model.supportedReasoningEfforts.map(
          (effort) => effort.reasoningEffort,
        ),
      })),
    );

  return models;
}
