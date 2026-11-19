import { useSyncExternalStore } from 'react';
import type { Preview } from '../core/preview.js';

const unwatched = () => () => {};

export function usePreview(owner?: Preview) {
  return useSyncExternalStore(
    owner?.subscribe ?? unwatched,
    () => owner?.snapshot,
  );
}
