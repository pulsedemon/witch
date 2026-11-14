import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk';

import type { Model } from './types.js';

/** Claude Code's model list as picker models. */
export function modelsOf(models: readonly ModelInfo[]): Model[] {
  return models.map((model) => ({
    id: model.value,
    label: model.displayName,
    efforts: model.supportedEffortLevels ?? [],
  }));
}
