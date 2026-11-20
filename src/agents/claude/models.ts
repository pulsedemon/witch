import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk';
import type { Model } from '../types.js';

/** Claude Code's model list as picker models. */
export function modelsOf(models: readonly ModelInfo[]): Model[] {
  return models.map((model) => ({
    id: model.value,
    label: model.displayName,
    efforts: model.supportedEffortLevels ?? [],
  }));
}

export function fallbackModel(change: {
  direction: string;
  scope?: string;
  original_model: string;
  fallback_model: string;
}): string | undefined {
  if (change.scope === 'local') return;

  return change.direction === 'revert'
    ? change.original_model
    : change.fallback_model;
}

export function reportedModel(model: string | undefined): string | undefined {
  return model === '<synthetic>' ? undefined : model;
}
