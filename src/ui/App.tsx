import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Box, Text, measureElement, useInput, useWindowSize } from 'ink';
import type { DOMElement } from 'ink';
import { textCommands } from '../agents/claude/spells.js';
import type { CompletionList } from './input/completion.js';
import type { Coordinator } from '../core/coordinator.js';
import type { Snapshot } from '../core/snapshot.js';
import type { JobWatch } from '../core/jobs/jobs.js';
import type { RepositoryWatch } from '../core/repository/repository.js';
import { agentWorking, contextStart } from '../core/state.js';
import type { StateStore } from '../persistence/store.js';
import {
  commands,
  claimedCommands,
  parseCommands,
  safeQueueMerge,
} from './commands/commands.js';
import { CommandView, useCommandViews } from './commands/CommandView.js';
import { CommandWindow } from './commands/CommandWindow.js';
import { chatLayout, toolHintLines } from './chat-layout.js';
import { Input } from './input/Input.js';
import { inputRows } from './input/input-layout.js';
import type { InputHandle } from './input/Input.js';
import type { InputBuffer } from './input/input-buffer.js';
import {
  activeToken,
  rankCommands,
  rankFiles,
  tokenKey,
} from './input/completion.js';
import { Request } from './Request.js';
import { Recovery } from './Recovery.js';
import { pageStart } from './scroll-page-layout.js';
import { canExpandDiff, diffExpansionHint } from './transcript/diff.js';
import type { Graphics } from './transcript/images.js';
import { TranscriptLayout } from './transcript/transcript-layout.js';
import type { ScrollAnchor } from './transcript/transcript-layout.js';
import { linkify, oneLine, plain } from './links.js';
import { useKeysReady } from './input/keys-ready.js';
import { useLiveState } from './live-state.js';
import { useDrafts } from './input/drafts.js';
import type { Browsing } from './input/drafts.js';
import { useClick, usePointer, useWheel } from './terminal/mouse.js';
import type { Cell } from './terminal/mouse.js';
import { highlight } from './transcript/selection.js';
import { useSelection } from './transcript/selection-state.js';
import { Activity } from './status/Activity.js';
import { agentActivity } from './status/agent-activity.js';
import { castTitle, useCasting } from './status/cast.js';
import { elapsed } from './status/elapsed.js';
import { Sidebar } from './status/Sidebar.js';
import { sidebarWidth, usagePlacement } from './status/sidebar-layout.js';
import type { delegation } from './commands/delegation.js';
import { StatusLine, useStatusTime } from './status/StatusLine.js';
import { statusFooter } from './status/status-rows.js';
import { PhaseRow } from './status/PhaseRow.js';
import { useToolFocus } from './transcript/tool-focus.js';
import { useExitConfirm } from './exit-confirm.js';
import { useFlash } from './flash.js';
import { accent, colors, potion } from './theme.js';
import { wrapSourceLines } from './wrap.js';
import type { RuntimeUpdates } from '../core/runtime/runtime-updates.js';
import { useRuntimeUpdates } from './commands/updates.js';

const unwatched = () => () => {};

const unbrowsed = (): Browsing => ({
  index: -1,
  texts: new Map<number, string>(),
});

export function App({
  coordinator,
  repository,
  onExit,
  onRestart,
  initialPrompt,
  graphics,
  jobs,
  store,
  policy,
  copy,
  updates,
}: {
  coordinator: Coordinator;
  updates?: RuntimeUpdates;
  /** the project's Git status for the status line, which leaves Git out without it. */
  repository?: Pick<RepositoryWatch, 'snapshot' | 'subscribe'>;
  /** draws images in the transcript, which leaves them out without it. */
  graphics?: Graphics;
  /** the agents' and `!` commands' jobs, which /jobs lists and stops; it lists none without them. */
  jobs?: Pick<JobWatch, 'list' | 'stop'>;
  /** keeps the prompts ↑ recalls across runs; without it, ↑ recalls only this run's. */
  store?: Pick<StateStore, 'prompts' | 'addPrompt'>;
  /** where /delegation reads and saves the routing policy; without it, /delegation shows the default and refuses a change. */
  policy?: Parameters<typeof delegation>[1];
  onExit(): void;

  /** replaces Witch with a fresh one on this conversation; /restart does nothing without it. */
  onRestart?(): void;

  /** puts text on the clipboard, where Cmd+C sends the transcript's selection, and calls `copied` once the clipboard holds it. */
  copy?(text: string, copied: () => void): void;
  /** sent once loading and cleanup end idle with nothing reported and tools unfocused, or ahead of a prompt submitted while waiting; otherwise left as the draft. */
  initialPrompt?: string;
}) {
  const updateSnapshot = useRuntimeUpdates(updates);

  const subscription = useMemo(
    () => (notify: () => void) => {
      let scheduled: ReturnType<typeof setTimeout> | undefined;

      const unsubscribe = coordinator.subscribe(() => {
        if (scheduled !== undefined) return;

        scheduled = setTimeout(() => {
          scheduled = undefined;
          notify();
        }, 40);
      });

      return () => {
        clearTimeout(scheduled);
        unsubscribe();
      };
    },
    [coordinator],
  );

  const state = useSyncExternalStore(subscription, () => coordinator.snapshot);
  const model = state.native?.model;

  const repositoryStatus = useSyncExternalStore(
    repository?.subscribe ?? unwatched,
    () => repository?.snapshot,
  );

  const coordination = useSyncExternalStore(
    coordinator.coordination?.subscribe ?? unwatched,
    () => coordinator.coordination?.snapshot,
  );

  const imageLoads = useSyncExternalStore(
    graphics?.subscribe ?? unwatched,
    () => graphics?.version,
  );

  const size = useWindowSize();
  const columns = Math.max(1, size.columns);
  const sidebar = columns - sidebarWidth >= 80;
  const width = sidebar ? columns - sidebarWidth : columns;
  const padding = width >= 7 ? 1 : 0;
  const bodyWidth = width - padding * 2;
  const height = Math.max(1, size.rows);
  const phaseRows = Number(height > 2);
  const statusTime = useStatusTime();
  const usage = usagePlacement(state, sidebar, height, statusTime);
  // the compiler needs the native fallback's string type to memoize its consumers.
  const cwd = state.conversation?.cwd ?? String(process.cwd());
  const [top, topRef, setAnchor] = useLiveState<ScrollAnchor | null>(null);

  const [seen, seenRef, setSeen] = useLiveState({
    conversation: state.conversation?.id,
    items: state.items,
  });

  const setTop = (anchor: ScrollAnchor | null) => {
    if (topRef.current === null || anchor === null)
      setSeen({ conversation: state.conversation?.id, items: state.items });

    setAnchor(anchor);
  };

  const commandViews = useCommandViews({
    coordinator,
    state,
    cwd,
    jobs,
    policy,
    updates,
    onExit,
    onRestart,
    toEnd: () => setTop(null),
  });

  const {
    view,
    viewRef,
    leaving,
    leavingRef,
    batches,
    dismissPicker,
    pageScroll,
    setPageScroll,
  } = commandViews;

  const toolFocus = useToolFocus(state.conversation?.id);
  const exit = useExitConfirm(onExit);
  const [copied, showCopied] = useFlash(1000);
  const composer = useRef<InputHandle>(null);
  // this directory's prompts, newest first
  const [prompts, history, setHistory] = useLiveState<string[]>([]);
  const [browsing, recall, setRecall] = useLiveState(unbrowsed);

  const { drafts, draftOf, draftToAppend, merged, setDraft } = useDrafts(
    coordinator,
    recall,
  );

  const [buffer, bufferRef, setBuffer] = useLiveState<InputBuffer>({
    value: '',
    cursor: 0,
  });

  const [listIndex, listIndexRef, setListIndex] = useLiveState(0);

  const [dismissed, dismissedRef, setDismissed] = useLiveState<
    string | undefined
  >(undefined);

  const [files, setFiles] = useState<string[]>([]);
  const pendingPrompt = useRef(initialPrompt);
  const [layout] = useState(() => new TranscriptLayout(graphics));

  const transcript = useMemo(
    () =>
      layout.render(
        state.items,
        bodyWidth,
        toolFocus.expanded,
        toolFocus.fullDiffs,
        imageLoads,
      ),
    [
      layout,
      state.items,
      bodyWidth,
      toolFocus.expanded,
      toolFocus.fullDiffs,
      imageLoads,
    ],
  );

  const casting = useCasting(state.items);
  const transcriptBox = useRef<DOMElement>(null);
  const newMessagesBox = useRef<DOMElement>(null);
  const pressedNewMessages = useRef(false);
  const liveAgent = state.native?.agent ?? state.conversation?.agent;

  /** a draft belongs to its conversation, so typing waits for the load or a switch to open one. */
  const composerOpen = (snapshot: Snapshot, leaving: string | undefined) =>
    !!snapshot.conversation &&
    snapshot.conversation.id !== leaving &&
    !['closing', 'error'].includes(snapshot.phase);

  const composerPhase = composerOpen(state, leaving);
  const working = agentWorking(state.phase);
  const agent = agentActivity(state);

  const commandEntries = commands.map(({ id, label, aliases }) => ({
    name: id,
    description: label,
    aliases: aliases?.slice(),
  }));

  const spellEntries = state.skills.filter(
    ({ name, builtin }) => !builtin && !claimedCommands.has(name),
  );

  /** a native command the list doesn't offer, which must send as typed rather than as a spell it matches. */
  const unlistedNative = (query: string) => {
    const name = query.toLowerCase();

    return (
      !claimedCommands.has(name) &&
      ((liveAgent === 'claude' && textCommands.has(name)) ||
        state.skills.some(
          ({ builtin, name: native, aliases = [] }) =>
            builtin && [native, ...aliases].includes(name),
        ))
    );
  };

  /** whether the composer holds the prompt ↑/↓ last showed, as shown. */
  const recalled = (
    value: string,
    { index, texts }: Browsing,
    prompts: string[],
  ) => index !== -1 && value === (texts.get(index) ?? prompts[index]);

  const listFor = (
    { value, cursor }: InputBuffer,
    focus: boolean,
    dismissedToken: string | undefined,
    isRecalled: boolean,
  ): CompletionList | undefined => {
    if (
      view.kind !== 'chat' ||
      !composerPhase ||
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

  const list = listFor(
    buffer,
    toolFocus.focused,
    dismissed,
    recalled(buffer.value, browsing, prompts),
  );

  const listSelected = list ? selectedIn(list, listIndex) : 0;

  /** keys in one read need the latest completion state before React renders it. */
  const liveListFor = (buffer: InputBuffer) =>
    listFor(
      buffer,
      toolFocus.focusedRef.current,
      dismissedRef.current,
      recalled(buffer.value, recall.current, history.current),
    );

  const tools = transcript.items.filter((item) => item.kind === 'tool');
  const selectedTool = tools[toolFocus.selected(tools, transcript.shownAs)];

  const diffHint =
    toolFocus.focused && selectedTool?.diff && canExpandDiff(selectedTool.diff)
      ? diffExpansionHint(toolFocus.fullDiffs.has(selectedTool.id))
      : undefined;

  const request = state.requests[0];
  const recovering = state.phase === 'recovery';
  const chat = view.kind === 'chat' && !request && !recovering;
  const toolHint = toolFocus.focused ? toolHintLines(bodyWidth, diffHint) : [];

  const controls = {
    working,
    pending: state.pendingCompaction,
    message: agent !== undefined,
    list: list?.items.length ?? 0,
    hints: toolHint.length,
  };

  const desired = chatLayout(height - phaseRows, bodyWidth, controls);

  const { lines: status, errors: errorRows } = statusFooter(
    {
      ...usage.status,
      model:
        state.models.find(
          ({ id, agent }) => id === model && agent === liveAgent,
        )?.label ?? model,
      effort: state.native?.effort ?? state.native?.nativeEffort,
      usage: state.usage,
      openedAt: state.openedAt,
      cwd,
      repository: repositoryStatus,
    },
    statusTime,
    {
      width: Math.max(1, width - 2),
      height,
      headerRows: phaseRows,
      error: state.error,
      bodyRows: Math.min(height - phaseRows, chat ? desired.minimumRows : 6),
    },
  );

  const bodyHeight = height - phaseRows - status.length - errorRows.length;
  const fitted = chatLayout(bodyHeight, bodyWidth, controls);
  const { list: listRows, transcript: minimumTranscriptRows } = fitted;
  const composerWidth = bodyWidth - (fitted.border ? 4 : 0);

  const wrappedInputRows = useMemo(
    () => inputRows(buffer.value, composerWidth, true),
    [buffer.value, composerWidth],
  );

  const composerRows = Math.min(fitted.composer, wrappedInputRows);
  const freeRows = fitted.content - composerRows;
  const listFirst = Math.max(0, listSelected - listRows + 1);

  // each shows one row, so a long paste is cleaned once and cut to it rather than on every render
  const queued = useMemo(
    () => state.queue.map((prompt) => oneLine(prompt).slice(0, width)),
    [state.queue, width],
  );

  const boundary = state.items[contextStart(state.items) - 1];
  const clearedAt = boundary && transcript.starts.get(boundary.id);

  const viewport = (anchor: ScrollAnchor | null, read = seen) => {
    const newMessages =
      anchor !== null &&
      read.conversation === state.conversation?.id &&
      read.items !== state.items;

    const queueRows = Math.max(
      0,
      Math.min(state.queue.length, freeRows - minimumTranscriptRows),
    );

    const availableRows = Math.max(minimumTranscriptRows, freeRows - queueRows);
    const row = anchor === null ? Infinity : transcript.rowOf(anchor);

    // decide before the notice takes a row, so hiding the last old row cannot turn it off
    const unpinnedTop = Math.min(
      row,
      Math.max(0, transcript.lines.length - availableRows),
    );

    const pinned =
      availableRows > 1 && clearedAt !== undefined && unpinnedTop < clearedAt;

    const height = availableRows - Number(pinned);
    const maxTop = Math.max(0, transcript.lines.length - height);

    return {
      pinned,
      newMessages,
      queueRows,
      height,
      maxTop,
      top: Math.min(row, maxTop),
    };
  };

  const {
    pinned,
    newMessages,
    queueRows,
    height: transcriptHeight,
    top: scrollTop,
  } = viewport(top);

  const scrollTo = (row: number | null) =>
    setTop(row === null ? null : (transcript.anchorAt(row) ?? null));

  /** scrolls from the latest position, so two page keys in one read move two pages. */
  const scrollBy = (rows: number, page = false) => {
    const { top, maxTop, height } = viewport(topRef.current, seenRef.current);

    const next = Math.min(
      maxTop,
      Math.max(0, top + rows * (page ? height : 1)),
    );

    // an anchored view can reach the bottom after output shrinks without resuming follow mode
    if (next !== top || (next === maxTop && topRef.current !== null))
      setTop(next === maxTop ? null : (transcript.anchorAt(next) ?? null));

    return next !== top;
  };

  /** records whether a press at `cell` is on the new-messages notice, which then takes the press, and returns it. */
  const pressedOnNewMessages = ({ column, row }: Cell) => {
    if (newMessagesBox.current) {
      const box = measureElement(newMessagesBox.current);

      pressedNewMessages.current =
        column >= box.x &&
        column < box.x + box.width &&
        row >= box.y &&
        row < box.y + box.height;
    }

    return pressedNewMessages.current;
  };

  const selection = useSelection({
    transcript,
    width,
    bodyWidth,
    box: transcriptBox,
    shown: chat,
    pinned,
    viewport: () => viewport(topRef.current, seenRef.current),
    scrollBy,
    covers: pressedOnNewMessages,
    copy,
    copied: showCopied,
  });

  const busy = working || ['editing', 'closing'].includes(state.phase);

  const run = (operation: Promise<unknown>) => {
    void operation.catch((error: unknown) => coordinator.report(error));
  };

  /** keeps a submitted prompt for ↑, unless it is blank or repeats the newest. */
  const remember = (text: string) => {
    if (!text.trim() || text === history.current[0]) return;

    setHistory([text, ...history.current]);
    // the initial prompt can go out once browsing has begun, and every prompt browsed or kept is then a place further back
    const back = (at: number) => (at === -1 ? at : at + 1);
    const { index, texts } = recall.current;

    setRecall({
      index: back(index),
      texts: new Map([...texts].map(([at, kept]) => [back(at), kept])),
    });

    if (store) run(store.addPrompt(cwd, text));
  };

  /** `composer` marks a submission the composer clears once it returns. */
  const submit = (text: string, composer = false): boolean => {
    // Enter while tools are focused toggles a tool, and one the composer would refuse keeps the draft, even in the
    // same read as the Tab or switch before it. a lone `!` has no command to run
    if (
      toolFocus.focusedRef.current ||
      !composerOpen(coordinator.snapshot, leavingRef.current) ||
      /^!\s*$/.test(text)
    )
      return false;

    const found = parseCommands(text, coordinator.snapshot.skills);

    if (found) {
      remember(text);
      commandViews.submit(found);

      return true;
    }

    setTop(null);
    // a prompt sent while the load connects would otherwise run ahead of the one Witch started with
    const initial = pendingPrompt.current;
    pendingPrompt.current = undefined;

    if (initial !== undefined) submit(initial);

    remember(text);
    run(coordinator.send(text, { composer }));

    return true;
  };

  const draft =
    (browsing.index === -1 ? draftOf(drafts, state) : browsing.texts.get(-1)) ??
    '';

  const draftEmpty = draft.length === 0;

  /** puts text back ahead of the draft, with the cursor after the text while the composer shows; it ends browsing, so the draft is the one typed before it. */
  const prepend = (text: string) => {
    const id = state.conversation?.id ?? '';
    const value = merged(text);
    setRecall(unbrowsed());

    if (composer.current) composer.current.set({ value, cursor: text.length });
    else setDraft(id, value);
  };

  /** puts the queue back ahead of the draft, as Claude Code's ↑ does. */
  const unqueue = () => {
    const snapshot = coordinator.snapshot;

    if (!snapshot.queue.length) return false;

    if (
      snapshot.phase !== 'error' &&
      (snapshot.commandsPending ||
        snapshot.pendingCompaction ||
        !safeQueueMerge(snapshot.queue, draftToAppend(), snapshot.skills))
    )
      return false;

    const text = snapshot.queue.join('\n');
    coordinator.unqueue(merged(text));
    prepend(text);

    return true;
  };

  /** shows the next older or newer prompt, keeping the composer's text for when browsing comes back to its place. */
  const browse = (direction: 'up' | 'down', current: InputBuffer) => {
    const { index, texts } = recall.current;
    const next = index + (direction === 'up' ? 1 : -1);
    const value = texts.get(next) ?? history.current[next];

    if (value === undefined) return false;

    setRecall({ index: next, texts: new Map(texts).set(index, current.value) });
    // ↑ lands at the end and ↓ at the start, so the next press walks a multiline prompt's lines first
    const cursor = direction === 'up' ? value.length : 0;
    composer.current?.set({ value, cursor });

    return true;
  };

  /** writes the selected entry into the draft: `/name ` replaces it, `@path ` replaces its token and a space already after it. a path `/review` would misread goes in double quotes. */
  const complete = (open: CompletionList) => {
    const index = selectedIn(open, listIndexRef.current);
    const { value } = bufferRef.current;

    if (open.kind === 'command') {
      const text = `/${open.items[index]!.name} `;
      composer.current?.set({ value: text, cursor: text.length });
    } else {
      const path = open.items[index]!;
      // bare, /review ends the name at a space or a quote and drops a backslash; inside quotes only `"` needs writing as `"\""`
      const text = `@${/[\s"'\\]/.test(path) ? `"${path.replaceAll('"', '"\\""')}"` : path} `;
      const rest = value.slice(open.end).replace(/^ /, '');

      composer.current?.set({
        value: value.slice(0, open.start) + text + rest,
        cursor: open.start + text.length,
      });
    }
  };

  const changeComposer = (value: string, cursor: number) => {
    const previous = bufferRef.current;
    setDraft(state.conversation?.id ?? '', value);
    setBuffer({ value, cursor });

    if (tokenKey(value, cursor) !== tokenKey(previous.value, previous.cursor)) {
      setListIndex(0);
      setDismissed(undefined);
    }

    if (
      activeToken(value, cursor)?.kind === 'file' &&
      activeToken(previous.value, previous.cursor)?.kind !== 'file'
    )
      run(coordinator.projectFiles().then(setFiles));
  };

  const moveInList = (direction: 'up' | 'down', current: InputBuffer) => {
    const open = liveListFor(current);

    if (!open) return false;

    const index = selectedIn(open, listIndexRef.current);

    setListIndex(
      direction === 'up'
        ? Math.max(0, index - 1)
        : Math.min(open.items.length - 1, index + 1),
    );

    return true;
  };

  /** ↑ on the first line takes the queue back, or else shows an older prompt; ↓ on the last line shows a newer one. */
  const arrow = (direction: 'up' | 'down', current: InputBuffer) =>
    // arrows while tools are focused move through tools, even in the same read as Tab
    toolFocus.focusedRef.current ||
    moveInList(direction, current) ||
    (direction === 'up'
      ? !current.value.slice(0, current.cursor).includes('\n') &&
        (coordinator.snapshot.queue.length
          ? (unqueue(), true)
          : browse('up', current))
      : !current.value.slice(current.cursor).includes('\n') &&
        browse('down', current));

  /** Enter runs the selected command or skill, and inserts a file without sending; a send starts browsing again at the newest. */
  const submitComposer = (text: string) => {
    // the Enter that follows a picker choice in one read was typed before the chosen command's view could open
    if (commandViews.chosenInRead.current) return false;

    const open = liveListFor(bufferRef.current);

    if (open?.kind === 'file') {
      complete(open);

      return false;
    }

    const accepted = submit(
      open
        ? `/${open.items[selectedIn(open, listIndexRef.current)]!.name}`
        : text,
      true,
    );

    if (accepted) setRecall(unbrowsed());

    return accepted;
  };

  useEffect(() => {
    setTop(null);
    const id = state.conversation?.id ?? '';

    return () => {
      // the shown prompt became this conversation's draft, so the one typed before browsing goes back
      const { index, texts } = recall.current;

      if (index !== -1) setDraft(id, texts.get(-1)!);

      setRecall(unbrowsed());
    };
  }, [state.conversation?.id]);

  // prompts sent before the read ends stay ahead of the ones it finds
  useEffect(() => {
    const directory = state.conversation?.cwd;

    if (store && directory)
      run(
        store.prompts(directory).then((found) => {
          setHistory([...history.current, ...found]);
        }),
      );
  }, [state.conversation?.cwd]);

  useEffect(() => {
    const prompt = pendingPrompt.current;

    if (
      prompt === undefined ||
      state.phase === 'starting' ||
      state.phase === 'cleaning'
    )
      return;

    pendingPrompt.current = undefined;

    if (state.phase !== 'idle' || state.error || !submit(prompt))
      prepend(prompt);
  }, [state.phase]);

  // a queued turn that never reached the agent comes back to edit, or to copy once nothing will run it
  useEffect(() => {
    if (['idle', 'error'].includes(state.phase) && state.queue.length)
      unqueue();
  }, [
    state.phase,
    state.queue,
    state.commandsPending,
    state.pendingCompaction,
    draftEmpty,
  ]);

  const recoveryReady = useKeysReady(state.phase === 'recovery');

  useEffect(() => {
    if (state.phase === 'recovery') setPageScroll(pageStart);
  }, [state.phase]);

  const recovery = recovering ? state.recovery : undefined;
  const conflict = recovery?.kind === 'conflict';

  const pageLines = useMemo(() => {
    const text = linkify(
      conflict
        ? `${recovery.paths.length ? `Conflicting paths:\n${recovery.paths.map(plain).join('\n')}` : 'This conflict has no single path.'}\n\nCommit that could not be published:\n${recovery.diff}`
        : (recovery?.diff ?? ''),
      recovery?.root ?? cwd,
    );

    return wrapSourceLines(text, bodyWidth);
  }, [recovery, conflict, cwd, bodyWidth]);

  usePointer((pointer, cell, presses) => {
    if (pointer === 'press' || pointer === 'release')
      pressedNewMessages.current = false;

    selection.point(pointer, cell, presses);
  });

  useClick(() => {
    if (
      pressedNewMessages.current &&
      newMessagesBox.current &&
      viewport(topRef.current, seenRef.current).newMessages
    ) {
      pressedNewMessages.current = false;
      setTop(null);
    }

    const tool = selection.pressedTool();

    if (tool) toolFocus.toggle(tool, transcript.members(tool.id));
  });

  useWheel((rows, cell) => {
    if (!request && !recovering && view.kind === 'chat') {
      if (scrollBy(rows)) selection.point('wheel', cell);
    }
  });

  useInput((input, key) => {
    if (key.eventType === 'release') return;

    if (key.ctrl && input === 'c') {
      // a second Ctrl+C while closing quits without waiting for the agent; a request can outlive its turn into recovery
      if (state.phase === 'closing' || state.phase === 'recovery') onExit();
      else if (busy || request || batches.pending) {
        run(coordinator.interrupt());
        batches.cancel();
        dismissPicker(false);
      } else if (
        viewRef.current.kind === 'chat' &&
        !toolFocus.focusedRef.current &&
        composerOpen(state, leavingRef.current) &&
        bufferRef.current.value
      )
        composer.current?.set({ value: '', cursor: 0 });
      else exit.press();

      return;
    }

    if (selection.key(input, key)) return;

    if (request) return;

    const modified = key.ctrl || key.meta || key.super;

    if (state.phase === 'recovery') {
      if (!recoveryReady || modified) return;

      const kind = recovery?.kind;

      if (input === 'd') run(coordinator.recoverMemory('discard'));

      if (input === 'a' && kind === 'pending')
        run(coordinator.recoverMemory('accept'));

      if (input === 'k' && kind === 'conflict')
        run(coordinator.recoverMemory('keep'));

      return;
    }

    const open = liveListFor(bufferRef.current);

    if (open && (key.tab || key.escape)) {
      if (key.tab) complete(open);
      else
        setDismissed(
          tokenKey(bufferRef.current.value, bufferRef.current.cursor),
        );

      return;
    }

    if (key.escape) {
      if (viewRef.current.kind !== 'chat') dismissPicker();
      else if (toolFocus.focusedRef.current) toolFocus.setFocused(false);
      else if (busy || batches.pending || state.phase === 'cleaning') {
        run(coordinator.interrupt());
        batches.cancel();
      }

      return;
    }

    if (key.ctrl && input === 'p') {
      run(commandViews.showCommands());

      return;
    }

    if (commandViews.handleKey(input, key)) return;

    if (key.pageUp) scrollBy(-1, true);

    if (key.pageDown) scrollBy(1, true);

    if (key.tab) toolFocus.setFocused(!toolFocus.focusedRef.current);

    if (toolFocus.focusedRef.current)
      toolFocus.key(
        input,
        key,
        tools,
        transcript.shownAs,
        transcript.members,
        (id) =>
          id === null
            ? setTop(null)
            : scrollTo(transcript.starts.get(id) ?? null),
      );
  });

  let body;

  if (request)
    body = (
      <Request
        key={request.id}
        request={request}
        width={bodyWidth}
        height={bodyHeight}
        cwd={cwd}
        respond={(response) => run(coordinator.respond(request.id, response))}
      />
    );
  else if (state.phase === 'recovery') {
    body = (
      <Recovery
        conflict={conflict}
        lines={pageLines}
        height={bodyHeight}
        width={bodyWidth}
        scroll={pageScroll}
        setScroll={setPageScroll}
      />
    );
  } else if (view.kind !== 'chat') {
    body = (
      <CommandView
        views={commandViews}
        width={bodyWidth}
        height={bodyHeight}
        cwd={cwd}
        coordination={coordination}
        updates={updateSnapshot}
        agents={state.agents}
      />
    );
  } else {
    const visible = transcript.lines.slice(
      scrollTop,
      scrollTop + transcriptHeight,
    );

    for (const [id, frame] of casting) {
      const row = transcript.starts.get(id);

      if (
        row !== undefined &&
        row >= scrollTop &&
        row - scrollTop < visible.length &&
        !(
          selection.ends &&
          row >= selection.ends[0].row &&
          row <= selection.ends[1].row
        )
      )
        visible[row - scrollTop] = castTitle(frame, bodyWidth);
    }

    const selectedToolRow = transcript.starts.get(selectedTool?.id ?? '');

    if (
      toolFocus.focused &&
      selectedToolRow !== undefined &&
      selectedToolRow >= scrollTop &&
      selectedToolRow < scrollTop + transcriptHeight
    )
      visible[selectedToolRow - scrollTop] = colors.inverse(
        visible[selectedToolRow - scrollTop],
      );

    if (selection.ends) {
      const [start, end] = selection.ends;

      for (
        let row = Math.max(scrollTop, start.row);
        row <= Math.min(end.row, scrollTop + visible.length - 1);
        row++
      )
        visible[row - scrollTop] = highlight(
          visible[row - scrollTop]!,
          row === start.row ? start.column : 0,
          row === end.row ? end.column + 1 : bodyWidth,
        );
    }

    body = (
      <Box flexDirection="column" height={bodyHeight}>
        {pinned && (
          <Text wrap="truncate-end">
            Earlier messages shown here are outside the agent's context.
          </Text>
        )}
        <Box ref={transcriptBox} height={transcriptHeight} overflow="hidden">
          <Text>
            {state.items.length
              ? visible.join('\n')
              : colors.dim(
                  'Start a conversation. Use /model to choose a Codex or Claude Code model.\nShared memory carries verified preferences between conversations.\nCtrl+P opens commands; /help lists keyboard controls.',
                )}
          </Text>
        </Box>
        <Box height={fitted.message} overflow="hidden" flexShrink={0}>
          {agent?.message && (
            <Text dimColor wrap="truncate-end">
              {`${elapsed(Math.max(0, statusTime - agent.message.at))} AGO · ${agent.message.text}`}
            </Text>
          )}
        </Box>
        {fitted.pending > 0 && (
          <Text dimColor wrap="truncate-end">
            Pending: /compact
          </Text>
        )}
        {queueRows > 0 && (
          <Box height={queueRows} flexDirection="column" overflow="hidden">
            {queued.slice(0, queueRows).map((prompt, index) => (
              <Text key={index} dimColor wrap="truncate-end">
                {`❯ ${prompt}`}
              </Text>
            ))}
          </Box>
        )}
        <CommandWindow items={state.items} height={fitted.commands} />
        <Box
          height={fitted.gap}
          overflow="hidden"
          flexShrink={0}
          justifyContent="center"
        >
          {newMessages && (
            <Box ref={newMessagesBox}>
              <Text color={accent} inverse>
                {' ↓ New messages '}
              </Text>
            </Box>
          )}
        </Box>
        <Box height={fitted.activity} overflow="hidden" flexShrink={0}>
          {working && (
            <Activity
              key={state.activityStartedAt}
              startedAt={state.activityStartedAt}
              compacting={state.phase === 'running' && state.nativeCompacting}
              quietSince={agent?.quietSince}
              reasonedAt={agent?.reasonedAt}
              doing={agent?.doing}
            />
          )}
        </Box>
        <Box
          borderStyle={fitted.border ? 'bold' : undefined}
          borderColor={
            toolFocus.focused
              ? 'gray'
              : buffer.value.startsWith('!')
                ? potion
                : accent
          }
          height={composerRows + (fitted.border ? 2 : 0)}
          paddingX={fitted.border ? 1 : 0}
          flexShrink={0}
        >
          <Input
            key={state.conversation?.id ?? 'initial'}
            width={composerWidth}
            height={composerRows}
            shell
            active={!toolFocus.focused && composerPhase}
            ref={composer}
            initialValue={draftOf(drafts, state) ?? ''}
            placeholder={
              state.queue.length
                ? !state.commandsPending &&
                  !state.pendingCompaction &&
                  safeQueueMerge(state.queue, draft, state.skills)
                  ? 'Press ↑ to edit queued messages'
                  : 'Messages remain queued'
                : undefined
            }
            onChange={changeComposer}
            onSubmit={submitComposer}
            onArrow={arrow}
            shiftArrows={selection.active}
            onPaste={coordinator.paste}
          />
        </Box>
        {list ? (
          <Box height={listRows} flexDirection="column" overflow="hidden">
            {(list.kind === 'file'
              ? list.items.map((path) => `@${path}`)
              : list.items.map(
                  ({ name, argumentHint, description }) =>
                    `/${name}${argumentHint ? ` ${argumentHint}` : ''} ${description}`,
                )
            )
              .slice(listFirst, listFirst + listRows)
              .map((text, row) => (
                <Text
                  key={listFirst + row}
                  inverse={listFirst + row === listSelected}
                  wrap="truncate-end"
                >
                  {/* Ink keeps OSC 8 links, so a project's file name or skill description could forge one */}
                  {oneLine(text)}
                </Text>
              ))}
          </Box>
        ) : (
          toolFocus.focused && (
            <Box height={listRows} overflow="hidden">
              <Text dimColor>{toolHint.slice(0, listRows).join('\n')}</Text>
            </Box>
          )
        )}
      </Box>
    );
  }

  return (
    <Box width={size.columns} height={size.rows} overflow="hidden">
      <Box width={columns} height={height}>
        <Box flexDirection="column" width={width} height={height}>
          <Box height={phaseRows} flexShrink={0} overflow="hidden">
            <PhaseRow
              state={state}
              reading={top !== null && view.kind === 'chat'}
              counts={!sidebar}
              exitArmed={exit.armed}
              copied={copied}
            />
          </Box>
          <Box
            flexDirection="column"
            height={bodyHeight}
            flexShrink={0}
            paddingX={padding}
            overflow="hidden"
          >
            {body}
          </Box>
          {errorRows.length > 0 && (
            <Box height={errorRows.length} paddingX={1} overflow="hidden">
              <Text color="red">{errorRows.join('\n')}</Text>
            </Box>
          )}
          <StatusLine lines={status} />
        </Box>
        {sidebar && (
          <Sidebar
            height={height}
            activity={coordinator.pentacle}
            brews={state.backgroundCommands}
            subagents={state.subagents}
            peers={coordination?.peers}
            usage={usage.sidebar}
          />
        )}
      </Box>
    </Box>
  );
}
