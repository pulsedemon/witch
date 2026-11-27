import { useRef } from 'react';
import { flushSync } from 'ink';
import type { Key } from 'ink';
import type { Choice, Picker, View } from './choices.js';
import type { InputHandle } from '../input/Input.js';
import { useLiveState } from '../useLiveState.js';

export function usePicker({
  view,
  viewRef,
  setView,
  report,
}: {
  view: View;
  viewRef: { readonly current: View };
  setView(view: View): void;

  report(error: unknown): void;
}) {
  const disposed = useRef(false);

  const pickerWait = useRef<PromiseWithResolvers<boolean> | undefined>(
    undefined,
  );

  const [query, queryRef, setQuery] = useLiveState('');
  const [selection, selectionRef, setSelection] = useLiveState(0);
  /** the choice rows CommandView drew; with none, Enter takes only a typed ID and the arrows do nothing. */
  const drawnRows = useRef(0);
  const pickerInput = useRef<InputHandle>(null);
  /** set for the rest of the read a picker choice came in, while the chosen command may still be opening its view. */
  const chosenInRead = useRef(false);

  /** an exact ID goes first, so Enter never picks a longer ID that contains it. */
  const filter = (entries: Choice[], text: string) =>
    entries
      .filter((choice) =>
        `${choice.label} ${choice.id} ${choice.search ?? ''}`
          .toLowerCase()
          .includes(text.toLowerCase()),
      )
      .sort(
        (a, b) =>
          Number(b.id === text.trim() || b.exact === text.trim()) -
          Number(a.id === text.trim() || a.exact === text.trim()),
      );

  const choices = view.kind === 'picker' ? filter(view.choices, query) : [];
  const selected = Math.min(selection, Math.max(0, choices.length - 1));

  /** renders chat before the rest of the key's read, so the keys after Esc or Ctrl+C reach the composer. */
  const dismissPicker = (success = true) => {
    const waiting = pickerWait.current;
    pickerWait.current = undefined;
    waiting?.resolve(success);
    flushSync(() => setView({ kind: 'chat' }));
  };

  const picker: Picker = (
    title,
    entries,
    choose,
    { custom = false, current } = {},
  ) => {
    if (disposed.current) return Promise.resolve(false);

    pickerWait.current?.resolve(true);
    const waiting = Promise.withResolvers<boolean>();
    pickerWait.current = waiting;
    pickerInput.current?.set({ value: '', cursor: 0 });
    setQuery('');

    setSelection(
      Math.max(
        0,
        filter([...entries], '').findIndex(({ id }) => id === current),
      ),
    );

    setView({
      kind: 'picker',
      title,
      choices: [...entries],
      custom,
      current,
      choose: (id) => {
        if (pickerWait.current !== waiting) return;

        // a nested picker owns the visible wait while this action still awaits its result
        pickerWait.current = undefined;
        chosenInRead.current = true;

        void Promise.resolve().then(() => {
          chosenInRead.current = false;
        });

        // chat renders before the rest of Enter's read, so the keys typed after the choice reach the composer
        flushSync(() => setView({ kind: 'chat' }));

        void (async () => {
          try {
            waiting.resolve((await choose(id)) !== false);
          } catch (error) {
            report(error);
            waiting.resolve(false);
          }
        })();

        // a picker the choice opened at once takes those keys instead
        if (viewRef.current.kind === 'picker') flushSync(() => {});
      },
    });

    return waiting.promise;
  };

  const choose = (text: string): boolean => {
    // the filter and selection a read changed are not rendered yet
    const current = viewRef.current;

    if (current.kind !== 'picker') return false;

    const matching = filter(current.choices, text);
    const typed = text.trim();

    const choice = drawnRows.current
      ? matching[Math.min(selectionRef.current, matching.length - 1)]
      : matching.find(
          ({ id, exact }) => typed && (id === typed || exact === typed),
        );

    if (choice) current.choose(choice.id);
    else if (current.custom && typed) current.choose(typed);
    else return false;

    return true;
  };

  // the filter input reports its empty text when it mounts, which must not move the selection off `current`
  const changeQuery = (text: string) => {
    if (text === queryRef.current) return;

    setQuery(text);
    setSelection(0);
  };

  const moveSelection = (key: Key) => {
    const current = viewRef.current;

    if (current.kind !== 'picker' || !drawnRows.current) return;

    // the filter a key earlier in this read changed is not rendered yet
    const count = filter(current.choices, queryRef.current).length;
    const at = Math.min(selectionRef.current, Math.max(0, count - 1));

    if (key.upArrow) setSelection(Math.max(0, at - 1));

    if (key.downArrow) setSelection(Math.max(0, Math.min(count - 1, at + 1)));
  };

  const close = () => {
    disposed.current = true;
    pickerWait.current?.resolve(false);
    pickerWait.current = undefined;
  };

  return {
    picker,
    dismissPicker,
    choose,
    changeQuery,
    choices,
    selected,
    pickerInput,
    chosenInRead,
    moveSelection,
    drawRows: (rows: number) => {
      drawnRows.current = rows;
    },
    close,
  };
}
