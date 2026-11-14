import { useEffect, useState } from 'react';
import type { Key } from 'ink';
import type { DisplayItem } from '../core/state.js';
import { canExpandDiff } from './diff.js';
import { useLiveState } from './live-state.js';
import { isExpanded, toggleGroup } from './transcript-layout.js';

/** where a shown row's id leads once grouping hides or regroups it; ungrouped, every id leads to itself. */
type ShownAs = (id: string) => string;

/** the tools a group row stands for; undefined for any other row. */
type Members = (id: string) => readonly DisplayItem[] | undefined;

/** the index of the selected tool among `tools`; with none selected, or one no longer shown, the first. */
function indexOf(
  tools: readonly DisplayItem[],
  shownAs: ShownAs,
  id: string | undefined,
): number {
  if (id === undefined) return 0;

  const shown = shownAs(id);

  return Math.max(
    0,
    tools.findIndex((tool) => tool.id === shown),
  );
}

/** Tab's tool focus: which tool is selected, by id so a row added above keeps it, and which tools are open. */
export function useToolFocus(conversation: string | undefined) {
  const [focused, focusedRef, setFocused] = useLiveState(false);

  const [selection, selectionRef, setSelection] = useLiveState<
    string | undefined
  >(undefined);

  const [expanded, setExpanded] = useState<ReadonlyMap<string, boolean>>(
    new Map(),
  );

  const [fullDiffs, setFullDiffs] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    setSelection(undefined);

    setFullDiffs(new Set());
  }, [conversation]);

  const toggle = (item: DisplayItem, members?: readonly DisplayItem[]) =>
    setExpanded((previous) =>
      members
        ? toggleGroup(members, previous)
        : new Map(previous).set(item.id, !isExpanded(item, previous)),
    );

  return {
    focused,
    focusedRef,
    setFocused,
    expanded,
    fullDiffs,
    toggle,
    selected: (tools: readonly DisplayItem[], shownAs: ShownAs) =>
      indexOf(tools, shownAs, selection),
    /** ↑/↓, End, Ctrl+O and Enter while focused; `scrollTo(null)` returns to live output. */
    key(
      input: string,
      key: Key,
      tools: readonly DisplayItem[],
      shownAs: ShownAs,
      members: Members,
      scrollTo: (id: string | null) => void,
    ) {
      const current = indexOf(tools, shownAs, selectionRef.current);
      let next = current;

      if (key.upArrow) next = Math.max(0, current - 1);

      if (key.downArrow)
        next = Math.max(0, Math.min(tools.length - 1, current + 1));

      const item = tools[next];

      if (next !== current && item) {
        setSelection(item.id);

        scrollTo(item.id);
      }

      if (key.end) scrollTo(null);

      if (key.ctrl && input === 'o' && item?.diff && canExpandDiff(item.diff)) {
        setFullDiffs((previous) => {
          const full = new Set(previous);

          if (full.has(item.id)) full.delete(item.id);
          else full.add(item.id);

          return full;
        });

        setExpanded((previous) => new Map(previous).set(item.id, true));

        scrollTo(item.id);
      }

      if (key.return && item) toggle(item, members(item.id));
    },
  };
}
