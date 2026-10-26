import { z } from 'zod';
import { taskStatuses } from './types.js';

export const familiarProgressSchema = z.object({
  status: z.enum(taskStatuses),
  model: z.string().min(1).optional(),
  activity: z.string().optional(),
  tools: z.number().int().nonnegative().optional(),
  report: z.string().optional(),
});
export type FamiliarProgress = z.infer<typeof familiarProgressSchema>;

export const familiarActionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('familiar-register'),
    run: z.string().uuid(),
    name: z.string().trim().min(1),
  }),
  z.object({
    kind: z.literal('familiar-update'),
    run: z.string().uuid(),
    sequence: z.number().int().nonnegative(),
    progress: familiarProgressSchema,
  }),
]);
export type FamiliarAction = z.infer<typeof familiarActionSchema>;

export const familiarOutcomeSchema = z.object({
  kind: z.enum(['familiar-registered', 'familiar-pending', 'familiar-updated']),
});
export type FamiliarOutcome = z.infer<typeof familiarOutcomeSchema>;

export const familiarMarkerSchema = z.object({
  version: z.literal(1),
  conversation: z.string().min(1),
  activation: z.string().uuid(),
  run: z.string().uuid(),
});
export type FamiliarMarker = z.infer<typeof familiarMarkerSchema>;
export const familiarMarkerPrefix = 'WITCH_FAMILIAR ';

export function familiarMarker(marker: FamiliarMarker): string {
  return `${familiarMarkerPrefix}${JSON.stringify(marker)}\n`;
}

export function readFamiliarMarker(line: string): FamiliarMarker | undefined {
  if (!line.startsWith(familiarMarkerPrefix)) return;
  try {
    return familiarMarkerSchema.safeParse(
      JSON.parse(line.slice(familiarMarkerPrefix.length)),
    ).data;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
}
