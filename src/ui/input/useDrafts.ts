import type { Coordinator } from '../../core/coordinator.js';
import type { Snapshot } from '../../core/snapshot.js';
import { useLiveState } from '../useLiveState.js';
import type { Browsing } from './usePromptHistory.js';

/** each conversation's composer text, this process's or else the one saved with it, saved with it as it changes. */
export function useDrafts(
  coordinator: Coordinator,
  recall: { readonly current: Browsing },
) {
  // keys in one read arrive before a render, so ↑ reads the live drafts
  const [drafts, draftsRef, setDrafts] = useLiveState<Record<string, string>>(
    {},
  );

  /** the draft typed before ↑ began browsing, which the composer no longer shows. */
  const typed = () => {
    const { index, texts } = recall.current;

    return index === -1 ? undefined : texts.get(-1);
  };

  const draftOf = (
    drafts: Record<string, string>,
    { conversation, draft }: Snapshot,
  ) => drafts[conversation?.id ?? ''] ?? draft;

  const draftToAppend = () =>
    typed() ?? draftOf(draftsRef.current, coordinator.snapshot) ?? '';

  return {
    drafts,
    draftOf,
    draftToAppend,
    /** `text` ahead of the draft typed before any browsing. */
    merged: (text: string) => {
      const draft = draftToAppend();

      return draft ? `${text}\n${draft}` : text;
    },
    setDraft: (id: string, value: string) => {
      setDrafts((previous) => ({ ...previous, [id]: value }));
      // a restart keeps the draft typed before browsing, as a switch does
      coordinator.draft(id, typed() ?? value);
    },
  };
}
