import { useState } from 'react';
import type { Skill } from '../../agents/types.js';
import { textCommands } from '../../agents/claude/spells.js';
import { commands, claimedCommands } from '../commands/commands.js';
import { useLiveState } from '../useLiveState.js';
import type { InputHandle } from './Input.js';
import type { InputBuffer } from './input-buffer.js';
import type { CompletionList } from './completion.js';
import {
  activeToken,
  rankCommands,
  rankFiles,
  tokenKey,
} from './completion.js';

export function useCompletion({
  open,
  focused,
  focusedRef,
  liveAgent,
  skills,
  buffer,
  bufferRef,
  recalled,
  recalledLive,
  composer,
  projectFiles,
  run,
}: {
  open: boolean;
  focused: boolean;
  focusedRef: { readonly current: boolean };
  liveAgent: string | undefined;
  skills: readonly Skill[];
  buffer: InputBuffer;
  bufferRef: { readonly current: InputBuffer };
  recalled(value: string): boolean;

  recalledLive(value: string): boolean;

  composer: { readonly current: InputHandle | null };
  projectFiles(): Promise<string[]>;

  run(operation: Promise<unknown>): void;
}) {
  const [listIndex, listIndexRef, setListIndex] = useLiveState(0);

  const [dismissed, dismissedRef, setDismissed] = useLiveState<
    string | undefined
  >(undefined);

  const [files, setFiles] = useState<string[]>([]);

  const commandEntries = commands.map(({ id, label, aliases }) => ({
    name: id,
    description: label,
    aliases: aliases?.slice(),
  }));

  const spellEntries = skills.filter(
    ({ name, builtin }) => !builtin && !claimedCommands.has(name),
  );

  /** a native command the list doesn't offer, which must send as typed rather than as a spell it matches. */
  const unlistedNative = (query: string) => {
    const name = query.toLowerCase();

    return (
      !claimedCommands.has(name) &&
      ((liveAgent === 'claude' && textCommands.has(name)) ||
        skills.some(
          ({ builtin, name: native, aliases = [] }) =>
            builtin && [native, ...aliases].includes(name),
        ))
    );
  };

  const listFor = (
    { value, cursor }: InputBuffer,
    focus: boolean,
    dismissedToken: string | undefined,
    isRecalled: boolean,
  ): CompletionList | undefined => {
    if (
      !open ||
      focus ||
      // a file would go into the command as `@path`
      value.startsWith('!') ||
      dismissedToken === tokenKey(value, cursor) ||
      // a list would take ↑/↓ from browsing, even once the cursor moves into a recalled `@path`
      isRecalled
    )
      return;

    const token = activeToken(value, cursor);

    if (token?.kind === 'command') {
      if (unlistedNative(token.query)) return;

      const items = rankCommands(token.query, commandEntries, spellEntries);

      return items.length ? { kind: 'command', items } : undefined;
    }

    if (token?.kind === 'file') {
      const items = rankFiles(token.query, files);

      return items.length ? { ...token, items } : undefined;
    }
  };

  const selectedIn = (open: CompletionList, index: number) =>
    Math.min(index, open.items.length - 1);

  const list = listFor(buffer, focused, dismissed, recalled(buffer.value));
  const listSelected = list ? selectedIn(list, listIndex) : 0;

  /** keys in one read need the latest completion state before React renders it. */
  const liveList = (buffer: InputBuffer) =>
    listFor(
      buffer,
      focusedRef.current,
      dismissedRef.current,
      recalledLive(buffer.value),
    );

  const complete = (open: CompletionList) => {
    const index = selectedIn(open, listIndexRef.current);
    const { value } = bufferRef.current;

    if (open.kind === 'command') {
      const text = `/${open.items[index]!.name} `;
      composer.current?.set({ value: text, cursor: text.length });
    } else {
      const path = open.items[index]!;
      // /review splits unquoted paths on whitespace and treats backslashes as escapes.
      const text = `@${/[\s"'\\]/.test(path) ? `"${path.replaceAll('"', '"\\""')}"` : path} `;
      const rest = value.slice(open.end).replace(/^ /, '');

      composer.current?.set({
        value: value.slice(0, open.start) + text + rest,
        cursor: open.start + text.length,
      });
    }
  };

  const changed = (previous: InputBuffer, next: InputBuffer) => {
    if (
      tokenKey(next.value, next.cursor) !==
      tokenKey(previous.value, previous.cursor)
    ) {
      setListIndex(0);
      setDismissed(undefined);
    }

    if (
      activeToken(next.value, next.cursor)?.kind === 'file' &&
      activeToken(previous.value, previous.cursor)?.kind !== 'file'
    )
      run(projectFiles().then(setFiles));
  };

  const move = (direction: 'up' | 'down', current: InputBuffer) => {
    const open = liveList(current);

    if (!open) return false;

    const index = selectedIn(open, listIndexRef.current);

    setListIndex(
      direction === 'up'
        ? Math.max(0, index - 1)
        : Math.min(open.items.length - 1, index + 1),
    );

    return true;
  };

  return {
    list,
    listSelected,
    liveList,
    complete,
    move,
    selectedIndex: (open: CompletionList) =>
      selectedIn(open, listIndexRef.current),
    dismiss: () =>
      setDismissed(tokenKey(bufferRef.current.value, bufferRef.current.cursor)),
    changed,
  };
}
