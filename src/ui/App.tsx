import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Box, Text, measureElement, useInput, useWindowSize } from 'ink';
import type { DOMElement } from 'ink';
import type { Coordinator } from '../core/coordinator.js';
import type { Snapshot } from '../core/snapshot.js';
import type { JobWatch } from '../core/jobs/jobs.js';
import type { RepositoryWatch } from '../core/repository/repository.js';
import { agentWorking, contextStart } from '../core/state.js';
import { modelKey } from '../core/runtime/models.js';
import type { StateStore } from '../persistence/store.js';
import { parseCommands, safeQueueMerge } from './commands/commands.js';
import { CommandView, useCommandViews } from './commands/CommandView.js';
import { CommandWindow } from './commands/CommandWindow.js';
import { chatLayout, toolHintLines } from './chat-layout.js';
import { Input } from './input/Input.js';
import { inputRows } from './input/input-layout.js';
import type { InputHandle } from './input/Input.js';
import type { InputBuffer } from './input/input-buffer.js';
import { Request } from './Request.js';
import { Preview } from './Preview.js';
import type { PreviewHandle } from './Preview.js';
import { usePreview } from './usePreview.js';
import { previewLayout } from './preview-layout.js';
import { Recovery } from './Recovery.js';
import { pageStart } from './scroll-page-layout.js';
import {
  canExpandDiff,
  diffExpansionHint,
  diffCopyRows,
} from './transcript/diff.js';
import type { Graphics } from './transcript/images.js';
import { TranscriptLayout } from './transcript/transcript-layout.js';
import type { ScrollAnchor } from './transcript/transcript-layout.js';
import { linkify, oneLine, plain } from './links.js';
import { useKeysReady } from './input/useKeysReady.js';
import { useLiveState } from './useLiveState.js';
import { useDrafts } from './input/useDrafts.js';
import { usePromptHistory } from './input/usePromptHistory.js';
import { useCompletion } from './input/useCompletion.js';
import { useClick, usePointer, useWheel } from './terminal/mouse.js';
import type { Cell } from './terminal/mouse.js';
import { transcriptViewport } from './transcript/viewport.js';
import { visibleRows } from './transcript/visible-rows.js';
import { useSelection } from './useSelection.js';
import { Activity } from './status/Activity.js';
import { agentActivity } from './status/agent-activity.js';
import { useCasting } from './status/cast.js';
import { elapsed } from './status/elapsed.js';
import { Sidebar } from './status/Sidebar.js';
import { sidebarWidth, usagePlacement } from './status/sidebar-layout.js';
import type { delegation } from './commands/delegation.js';
import { StatusLine, useStatusTime } from './status/StatusLine.js';
import { statusFooter } from './status/status-rows.js';
import { PhaseRow } from './status/PhaseRow.js';
import { useToolFocus } from './transcript/useToolFocus.js';
import { useExitConfirm } from './useExitConfirm.js';
import { useFlash } from './useFlash.js';
import { accent, colors, potion } from './theme.js';
import { wrapSourceLines } from './wrap.js';

const unwatched = () => () => {};

function queueMerges(
  snapshot: Pick<
    Snapshot,
    'queue' | 'commandsPending' | 'pendingCompaction' | 'skills'
  >,
  draft: string,
): boolean {
  return (
    !snapshot.commandsPending &&
    !snapshot.pendingCompaction &&
    safeQueueMerge(snapshot.queue, draft, snapshot.skills)
  );
}

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
}: {
  coordinator: Coordinator;
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

  /** puts text on the clipboard, where Cmd+C sends the visible text selection, and calls `copied` once the clipboard holds it. */
  copy?(text: string, copied: () => void): void;
  /** sent once loading and cleanup end idle with nothing reported and tools unfocused, or ahead of a prompt submitted while waiting; otherwise left as the draft. */
  initialPrompt?: string;
}) {
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

  const preview = usePreview(coordinator.coordination?.preview);
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
    jobs,
    policy,
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
  const previewHandle = useRef<PreviewHandle>(null);

  const run = (operation: Promise<unknown>) => {
    void operation.catch((error: unknown) => coordinator.report(error));
  };

  const { browsing, recall, recalled, recalledLive, remember, browse, reset } =
    usePromptHistory({
      store,
      cwd,
      directory: state.conversation?.cwd,
      composer,
      run,
    });

  const { drafts, draftOf, draftToAppend, merged, setDraft } = useDrafts(
    coordinator,
    recall,
  );

  const [buffer, bufferRef, setBuffer] = useLiveState<InputBuffer>({
    value: '',
    cursor: 0,
  });

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

  const completion = useCompletion({
    open: view.kind === 'chat' && composerPhase,
    focused: toolFocus.focused,
    focusedRef: toolFocus.focusedRef,
    liveAgent,
    skills: state.skills,
    buffer,
    bufferRef,
    recalled,
    recalledLive,
    composer,
    projectFiles: () => coordinator.projectFiles(),
    run,
  });

  const { list, listSelected } = completion;
  const selectedTool = toolFocus.selectedTool(transcript);

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
    pending: state.pendingCompaction || !!state.pendingModel,
    message: agent !== undefined,
    list: list?.items.length ?? 0,
    hints: toolHint.length,
  };

  const desired = chatLayout(height - phaseRows, bodyWidth, controls);

  const {
    lines: status,
    errors: errorRows,
    yielded,
  } = statusFooter(
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
      release: chat ? desired.commands + desired.gap : 0,
    },
  );

  const bodyHeight = height - phaseRows - status.length - errorRows.length;
  const fitted = chatLayout(bodyHeight, bodyWidth, { ...controls, yielded });
  const { list: listRows, transcript: minimumTranscriptRows } = fitted;

  // from the height rather than the last render, so a key read with the `/` that opens a list sees it
  const completionFits =
    chatLayout(bodyHeight, bodyWidth, { ...controls, yielded, list: 1 }).list >
    0;

  const shownList = (current: InputBuffer) =>
    completionFits ? completion.liveList(current) : undefined;

  const composerWidth = bodyWidth - (fitted.border ? 4 : 0);

  const wrappedInputRows = useMemo(
    () => inputRows(buffer.value, composerWidth, true),
    [buffer.value, composerWidth],
  );

  const composerRows = Math.min(fitted.composer, wrappedInputRows);
  const previewHeight = fitted.content - composerRows;

  // the transcript keeps at least half, so the reply a preview is shown for stays readable
  const previewSpace = previewLayout(
    previewHeight,
    Math.max(
      minimumTranscriptRows,
      Math.ceil((previewHeight - state.queue.length) / 2),
    ) + state.queue.length,
    chat ? preview?.status : undefined,
  );

  const freeRows = previewSpace.body;
  const listFirst = Math.max(0, listSelected - listRows + 1);

  // each shows one row, so a long paste is cleaned once and cut to it rather than on every render
  const queued = useMemo(
    () => state.queue.map((prompt) => oneLine(prompt).slice(0, width)),
    [state.queue, width],
  );

  const boundary = state.items[contextStart(state.items) - 1];
  const clearedAt = boundary && transcript.starts.get(boundary.id);

  const viewport = (anchor: ScrollAnchor | null, read = seen) =>
    transcriptViewport({
      anchor,
      read,
      conversation: state.conversation?.id,
      items: state.items,
      queue: state.queue.length,
      freeRows,
      minimumRows: minimumTranscriptRows,
      transcript,
      clearedAt,
    });

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

  const markerAt = (anchor: ScrollAnchor, column: number) => {
    const item = transcript.items.find(({ id }) => id === anchor.item);

    return item?.kind === 'tool' &&
      column < 3 &&
      transcript.rowOf(anchor) === transcript.starts.get(item.id)
      ? item
      : undefined;
  };

  const currentConversation = () =>
    coordinator.snapshot.conversation?.id === state.conversation?.id;

  const copySelection = (text: string) => copy?.(text, showCopied);

  const selection = useSelection({
    source: {
      ...transcript,
      rowOf: (anchor: ScrollAnchor) =>
        transcript.starts.has(anchor.item)
          ? transcript.rowOf(anchor)
          : undefined,
      sameAnchor: (a: ScrollAnchor, b: ScrollAnchor) =>
        a.item === b.item && a.line === b.line && a.offset === b.offset,
    },
    identity: state.conversation?.id,
    continueDragOnChange: true,
    width,
    bodyWidth,
    box: transcriptBox,
    shown: () =>
      currentConversation() &&
      viewRef.current.kind === 'chat' &&
      !coordinator.snapshot.requests.length &&
      coordinator.snapshot.phase !== 'recovery',
    viewport: () => {
      const current = viewport(topRef.current, seenRef.current);

      return {
        ...current,
        originShift: Number(current.pinned) - Number(pinned),
      };
    },
    scrollBy,
    covers: pressedOnNewMessages,
    copy: copySelection,
    markerAt: (anchor, column) => !!markerAt(anchor, column),
  });

  const busy = working || ['editing', 'closing'].includes(state.phase);

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
    reset();

    if (composer.current) composer.current.set({ value, cursor: text.length });
    else setDraft(id, value);
  };

  /** puts the queue back ahead of the draft, as Claude Code's ↑ does. */
  const unqueue = () => {
    const snapshot = coordinator.snapshot;

    if (!snapshot.queue.length) return false;

    if (snapshot.phase !== 'error' && !queueMerges(snapshot, draftToAppend()))
      return false;

    const text = snapshot.queue.join('\n');
    coordinator.unqueue(merged(text));
    prepend(text);

    return true;
  };

  const changeComposer = (value: string, cursor: number) => {
    const previous = bufferRef.current;
    const next = { value, cursor };
    setDraft(state.conversation?.id ?? '', value);
    setBuffer(next);
    completion.changed(previous, next);
  };

  /** ↑ on the first line takes the queue back, or else shows an older prompt; ↓ on the last line shows a newer one. */
  const arrow = (direction: 'up' | 'down', current: InputBuffer) =>
    // arrows while tools are focused move through tools, even in the same read as Tab
    toolFocus.focusedRef.current ||
    (completionFits && completion.move(direction, current)) ||
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

    const open = shownList(bufferRef.current);

    if (open?.kind === 'file') {
      completion.complete(open);

      return false;
    }

    const accepted = submit(
      open ? `/${open.items[completion.selectedIndex(open)]!.name}` : text,
      true,
    );

    if (accepted) reset();

    return accepted;
  };

  useEffect(() => {
    setTop(null);
    const id = state.conversation?.id ?? '';

    return () => {
      // the shown prompt became this conversation's draft, so the one typed before browsing goes back
      const { index, texts } = recall.current;

      if (index !== -1) setDraft(id, texts.get(-1)!);

      reset();
    };
  }, [state.conversation?.id]);

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
    const root = recovery?.root ?? cwd;

    const explanation = conflict
      ? `${recovery.paths.length ? `Conflicting paths:\n${recovery.paths.map(plain).join('\n')}` : 'This conflict has no single path.'}\n\nCommit that could not be published:`
      : '';

    const diff = diffCopyRows(
      wrapSourceLines(linkify(recovery?.diff ?? '', root), bodyWidth),
    );

    return explanation
      ? [...wrapSourceLines(linkify(explanation, root), bodyWidth), ...diff]
      : diff;
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

    const pressed = selection.pressed();
    const tool = pressed && markerAt(pressed.anchor, pressed.column);

    if (tool) toolFocus.toggle(tool, transcript.members(tool.id));
  });

  useWheel((rows, cell) => {
    if (chat && !previewHandle.current?.wheel(rows, cell)) {
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

    const open = shownList(bufferRef.current);

    if (open && (key.tab || key.escape)) {
      if (key.tab) completion.complete(open);
      else completion.dismiss();

      return;
    }

    // a list too short to draw takes Tab, so it neither completes unseen nor focuses tools
    if (key.tab && completion.liveList(bufferRef.current)) return;

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
      toolFocus.key(input, key, transcript, (id) =>
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
        copy={copySelection}
        current={() =>
          currentConversation() &&
          coordinator.snapshot.requests[0]?.id === request.id
        }
        preview={coordinator.coordination?.preview}
        width={bodyWidth}
        height={bodyHeight}
        cwd={cwd}
        respond={(response) => run(coordinator.respond(request.id, response))}
      />
    );
  else if (state.phase === 'recovery') {
    body = (
      <Recovery
        identity={recovery}
        copy={copySelection}
        current={() =>
          currentConversation() &&
          !coordinator.snapshot.requests.length &&
          coordinator.snapshot.phase === 'recovery' &&
          coordinator.snapshot.recovery === recovery
        }
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
        copy={copySelection}
        current={() =>
          currentConversation() &&
          !coordinator.snapshot.requests.length &&
          coordinator.snapshot.phase !== 'recovery'
        }
        width={bodyWidth}
        height={bodyHeight}
        cwd={cwd}
        coordination={coordination}
      />
    );
  } else {
    const visible = visibleRows(transcript.lines, {
      top: scrollTop,
      height: transcriptHeight,
      casting,
      starts: transcript.starts,
      selectedRow: toolFocus.focused
        ? transcript.starts.get(selectedTool?.id ?? '')
        : undefined,
      ends: selection.ends,
      width: bodyWidth,
    });

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
        <Preview
          ref={previewHandle}
          owner={coordinator.coordination?.preview}
          width={bodyWidth}
          height={previewSpace.preview}
        />
        <Box height={fitted.message} overflow="hidden" flexShrink={0}>
          {agent?.message && (
            <Text dimColor wrap="truncate-end">
              {`${elapsed(Math.max(0, statusTime - agent.message.at))} AGO · ${agent.message.text}`}
            </Text>
          )}
        </Box>
        {fitted.pending > 0 && (
          <Text dimColor wrap="truncate-end">
            Pending:{' '}
            {[
              ...(state.pendingCompaction ? ['/compact'] : []),
              ...(state.pendingModel
                ? [
                    `/model ${modelKey(state.pendingModel)}${state.pendingModel.effort ? ` ${state.pendingModel.effort}` : ''}`,
                  ]
                : []),
            ].join('; ')}
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
                ? queueMerges(state, draft)
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
