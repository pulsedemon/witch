import { z } from 'zod';
import type { JsonRpc } from './json-rpc.js';
import type { Model } from './types.js';

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

export async function readModels(rpc: JsonRpc): Promise<Model[]> {
  const models: Model[] = [];
  let cursor: string | null = null;
  do {
    const page = modelPage.parse(
      await rpc.request('model/list', { cursor, limit: 100 }),
    );
    models.push(
      ...page.data.map((model) => ({
        id: model.id,
        label: model.displayName,
        efforts: model.supportedReasoningEfforts.map(
          (effort) => effort.reasoningEffort,
        ),
      })),
    );
    cursor = page.nextCursor;
  } while (cursor);
  return models;
}
