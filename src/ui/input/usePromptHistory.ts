import { useEffect } from 'react';
import type { StateStore } from '../../persistence/store.js';
import type { InputHandle } from './Input.js';
import type { InputBuffer } from './input-buffer.js';
import { useLiveState } from '../useLiveState.js';

/** where ↑/↓ stand among earlier prompts, -1 being the draft, with the composer's text at each place they left. */
export interface Browsing {
  index: number;
  texts: Map<number, string>;
}

const unbrowsed = (): Browsing => ({
  index: -1,
  texts: new Map<number, string>(),
});

/** saves under cwd; loading waits for the open conversation's directory. */
export function usePromptHistory({
  store,
  cwd,
  directory,
  composer,
  run,
}: {
  store?: Pick<StateStore, 'prompts' | 'addPrompt'>;
  cwd: string;
  directory: string | undefined;
  composer: { readonly current: InputHandle | null };
  run(operation: Promise<unknown>): void;
}) {
  const [prompts, history, setHistory] = useLiveState<string[]>([]);
  const [browsing, recall, setRecall] = useLiveState(unbrowsed);

  const recalled = (
    value: string,
    { index, texts }: Browsing,
    prompts: string[],
  ) => index !== -1 && value === (texts.get(index) ?? prompts[index]);

  const remember = (text: string) => {
    if (!text.trim() || text === history.current[0]) return;

    setHistory([text, ...history.current]);
    // an initial prompt can arrive mid-browse, shifting the saved positions.
    const back = (at: number) => (at === -1 ? at : at + 1);
    const { index, texts } = recall.current;

    setRecall({
      index: back(index),
      texts: new Map([...texts].map(([at, kept]) => [back(at), kept])),
    });

    if (store) run(store.addPrompt(cwd, text));
  };

  const browse = (direction: 'up' | 'down', current: InputBuffer) => {
    const { index, texts } = recall.current;
    const next = index + (direction === 'up' ? 1 : -1);
    const value = texts.get(next) ?? history.current[next];

    if (value === undefined) return false;

    setRecall({ index: next, texts: new Map(texts).set(index, current.value) });
    // ↑ lands at the end and ↓ at the start, so the next press walks a multiline prompt's lines first.
    const cursor = direction === 'up' ? value.length : 0;
    composer.current?.set({ value, cursor });

    return true;
  };

  // prompts submitted while loading stay ahead of the saved ones.
  useEffect(() => {
    if (store && directory)
      run(
        store.prompts(directory).then((found) => {
          setHistory([...history.current, ...found]);
        }),
      );
  }, [directory]);

  return {
    browsing,
    recall,
    recalled: (value: string) => recalled(value, browsing, prompts),
    recalledLive: (value: string) =>
      recalled(value, recall.current, history.current),
    remember,
    browse,
    reset: () => setRecall(unbrowsed()),
  };
}
