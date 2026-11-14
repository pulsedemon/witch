import { readFileSync } from 'node:fs';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { errorMessage } from '../errors.js';
import type { SkillCall, TurnResult } from './types.js';

type Content = SDKUserMessage['message']['content'];

// `@anthropic-ai/sdk`, which names this type, isn't a direct dependency
type ImageBlock = Extract<Exclude<Content, string>[number], { type: 'image' }>;

/** reads synchronously, so no await opens a gap in which an interrupt is ignored; a failure is the turn's result. */
export function readImages(
  paths: readonly string[],
): ImageBlock[] | TurnResult {
  try {
    return paths.map((path): ImageBlock => ({
      type: 'image',
      source: {
        type: 'base64',
        media_type: path.endsWith('.png') ? 'image/png' : 'image/jpeg',
        data: readFileSync(path).toString('base64'),
      },
    }));
  } catch (error) {
    return {
      status: 'failed',
      text: '',
      error: errorMessage(error),
      inputUnsent: true,
    };
  }
}

/**
 * the records of commands run since the last prompt go ahead of it, and a skill goes last, since the CLI dispatches a
 * command only from the last text block and the rest become its context. the Messages API rejects an empty text block.
 */
export function content(
  records: readonly string[],
  text: string,
  images: readonly ImageBlock[],
  skill?: SkillCall,
): Content {
  const texts = [...records, ...(text ? [text] : [])];

  const command = skill
    ? [`/${skill.name}${skill.args ? ` ${skill.args}` : ''}`]
    : [];

  if (!images.length && texts.length + command.length <= 1)
    return texts[0] ?? command[0] ?? text;

  return [...texts.map(textBlock), ...images, ...command.map(textBlock)];
}

function textBlock(text: string) {
  return { type: 'text' as const, text };
}
