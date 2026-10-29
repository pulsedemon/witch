import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Box, Text, measureElement, useInput, useWindowSize } from 'ink';
import type { DOMElement } from 'ink';
import { dirname, join } from 'node:path';
import stripAnsi from 'strip-ansi';
import { errorMessage } from '../agents/stderr.js';
import type { Skill } from '../agents/types.js';
import type { Coordinator } from '../core/coordinator.js';
import type { Snapshot } from '../core/snapshot.js';
import { modelKey, modelTarget } from '../core/models.js';
import type { JobWatch } from '../core/jobs.js';
import type { RepositoryWatch } from '../core/repository.js';
import { agentWorking, contextStart } from '../core/state.js';
import type { StateStore } from '../persistence/store.js';
import { Input, inputRows } from './input.js';
import type { InputHandle } from './input.js';
import type { InputBuffer } from './input-buffer.js';
import {
  activeToken,
  rankCommands,
  rankFiles,
  tokenKey,
} from './completion.js';
import { Request } from './request.js';
import { canExpandDiff, diffExpansionHint } from './diff.js';
import type { Graphics } from './images.js';
import { isExpanded, TranscriptLayout } from './transcript-layout.js';
import type { ScrollAnchor } from './transcript-layout.js';
import { markdown } from './markdown.js';
import { hyperlink, linkify, oneLine, plain } from './links.js';
import { useKeysReady } from './keys-ready.js';
import { useLiveState } from './live-state.js';
import { usePointer, useWheel } from './mouse.js';
import { highlight, selectedText } from './selection.js';
import type { Point } from './selection.js';
import { Activity, elapsed } from './activity.js';
import { castTitle, useCasting } from './cast.js';
import { fitsUsage, Sidebar, sidebarWidth } from './sidebar.js';
import { coordinationText } from './peers.js';
import { StatusLine } from './status-line.js';
import { ScrollPage } from './scroll-page.js';
import { accent, colors, piped, potion } from './theme.js';
import { wrapLines } from './wrap.js';

const commands: { id: string; label: string; aliases?: string[] }[] = [
  { id: 'new', label: 'New conversation' },
  { id: 'sessions', label: 'Saved conversations' },
  { id: 'peers', label: 'Other sessions in this repository' },
  {
    id: 'task',
    label: 'Current task, /task release or /task take <reference>',
  },
  { id: 'model', label: 'Choose model and reasoning' },
  { id: 'compact', label: 'Compact the conversation' },
  { id: 'clear', label: 'Clear agent context' },
  { id: 'memory', label: 'Browse shared memory' },
  { id: 'jobs', label: 'Running jobs' },
  { id: 'help', label: 'Keyboard help' },
  { id: 'restart', label: 'Restart Witch in this conversation' },
  { id: 'exit', label: 'Exit', aliases: ['quit'] },
];
const claimed = new Set(
  commands.flatMap(({ id, aliases = [] }) => [id, ...aliases]),
);

/** what the composer's open list offers: commands and skills, or files for the `@` token at `[start, end)`. */
type List =
  | { kind: 'command'; items: Skill[] }
  | { kind: 'file'; start: number; end: number; items: string[] };

interface Choice {
  id: string;
  label: string;
  search?: string;
  exact?: string;
  cwd?: string;
}
type View =
  | { kind: 'chat' }
  | { kind: 'coordination'; mode: 'peers' | 'task' }
  | {
      kind: 'picker';
      title: string;
      choices: Choice[];
      choose(id: string): void;
      custom?: boolean;
    }
  | {
      kind: 'page';
      title: string;
      text: string;
      /** the absolute file the title links to, when there is one. */
      link?: string;
      /** a memory note's relative path, for edit and history. */
      note?: string;
    };

const unwatched = () => () => {};

/** one end of a drag in the transcript: the row it is on, by its text, and the column. */
interface RangeEnd {
  anchor: ScrollAnchor;
  column: number;
  /** the width it was measured at; a width change drops the range, since a column from a wider one can lie past the edge. */
  width: number;
  /** its row as measured; output growing into the row, or its tool expanding or collapsing, changes it. */
  text: string;
}

/** where ↑/↓ stand among earlier prompts, -1 being the draft, with the composer's text at each place they left. */
const unbrowsed = () => ({ index: -1, texts: new Map<number, string>() });

export function App({
  coordinator,
  repository,
  onExit,
  onRestart,
  initialPrompt,
  graphics,
  jobs,
  store,
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
  onExit(): void;
  /** replaces Witch with a fresh one on this conversation; /restart does nothing without it. */
  onRestart?(): void;
  /** puts text on the clipboard, where Cmd+C sends the transcript's selection. */
  copy?(text: string): void;
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
  const columns = Math.max(30, size.columns);
  // the sidebar shows only beside a main column of 80 cells
  const sidebar = columns - sidebarWidth >= 80;
  const width = sidebar ? columns - sidebarWidth : columns;
  /** inside the body's paddingX. */
  const bodyWidth = width - 2;
  /** inside the composer's border and paddingX. */
  const composerWidth = bodyWidth - 4;
  const height = Math.max(12, size.rows);
  const live = state.native?.agent ?? state.conversation?.agent;
  const readings = state.agents
    .filter(({ installed }) => installed)
    .map(({ id }) => ({ id, limits: state.limits[id] }));
  // usage shows once any runtime has reported, so a fresh start isn't a column of `?`
  const accounts = readings.some(({ limits }) => limits) ? readings : [];
  const usageInSidebar = sidebar && fitsUsage(height, accounts);
  // the compiler needs the native fallback's string type to memoize its consumers.
  const cwd = state.conversation?.cwd ?? String(process.cwd());
  const [view, viewRef, setView] = useLiveState<View>({ kind: 'chat' });
  const [query, setQuery] = useState('');
  const [selection, selectionRef, setSelection] = useLiveState(0);
  const [pageScroll, setPageScroll] = useState(0);
  const [top, topRef, setTop] = useLiveState<ScrollAnchor | null>(null);
  const [toolFocus, toolFocusRef, setToolFocus] = useLiveState(false);
  const [toolSelection, toolSelectionRef, setToolSelection] = useLiveState(0);
  const [expanded, setExpanded] = useState<Map<string, boolean>>(new Map());
  const [fullDiffs, setFullDiffs] = useState<Set<string>>(new Set());
  // keys in one read arrive before a render, so ↑ reads the live drafts
  const [drafts, draftsRef, setDrafts] = useLiveState<Record<string, string>>(
    {},
  );
  const setDraft = (id: string, value: string) =>
    setDrafts((previous) => ({ ...previous, [id]: value }));
  const [leaving, leavingRef, setLeaving] = useLiveState<string | undefined>(
    undefined,
  );
  const composer = useRef<InputHandle>(null);
  const pickerInput = useRef<InputHandle>(null);
  // this directory's prompts, newest first
  const [prompts, history, setHistory] = useLiveState<string[]>([]);
  const [browsing, recall, setRecall] = useLiveState(unbrowsed);
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
      layout.render(state.items, bodyWidth, expanded, fullDiffs, imageLoads),
    [layout, state.items, bodyWidth, expanded, fullDiffs, imageLoads],
  );
  const casting = useCasting(state.items);
  // a drag's ends are anchored to their text, so they follow it when output above grows
  const [range, rangeRef, setRange] = useLiveState<
    { from: RangeEnd; to: RangeEnd } | undefined
  >(undefined);
  const pressedAt = useRef<RangeEnd>(undefined);
  const transcriptBox = useRef<DOMElement>(null);
  /** where an end is drawn: at the width it was measured at, in an item still shown, while its row reads as it did. */
  const pointOf = (end: RangeEnd): Point | undefined => {
    const row = transcript.rowOf(end.anchor);
    return end.width === width &&
      transcript.starts.has(end.anchor.item) &&
      transcript.lines.at(row) === end.text
      ? { row, column: end.column }
      : undefined;
  };
  /** a range's ends in reading order, while both are drawn. */
  const endsOf = (dragged: typeof range) => {
    const from = dragged && pointOf(dragged.from);
    const to = dragged && pointOf(dragged.to);
    return from && to
      ? ([from, to].sort((a, b) => a.row - b.row || a.column - b.column) as [
          Point,
          Point,
        ])
      : undefined;
  };
  const ends = endsOf(range);
  // a range or a held press off its text drops, so it can't come back with the width or the tool
  useEffect(() => {
    if (range && !ends) setRange(undefined);
    if (pressedAt.current && !pointOf(pressedAt.current))
      pressedAt.current = undefined;
  });
  /** what joins a row to the one above: a line break, or for a wrapped row the spaces its wrap trimmed. */
  const joint = (row: number) => {
    const here = transcript.anchorAt(row);
    const above = transcript.anchorAt(row - 1);
    if (!here || !above || here.item !== above.item || here.line !== above.line)
      return '\n';
    // a row its wrap changed beyond trimming is not found in its line and has offset -1, so take the break as a space
    if (here.offset < 0 || above.offset < 0) return ' ';
    const trimmed =
      here.offset -
      above.offset -
      stripAnsi(transcript.lines.at(row - 1)!).length;
    // a diff row's offset counts rows, not characters, so it leaves no room for the row above
    return trimmed < 0 ? '\n' : ' '.repeat(trimmed);
  };
  const errorLimit = Math.max(1, Math.floor(height / 3));
  // an error can quote an agent-written note name
  const errorLines = state.error
    ? wrapLines(linkify(plain(state.error), cwd), width - 2)
    : [];
  const errorRows =
    errorLines.length > errorLimit
      ? [
          ...errorLines.slice(0, errorLimit - 1),
          `+${errorLines.length - errorLimit + 1} more rows`,
        ]
      : errorLines;
  // the phase row above, the status line's two below
  const bodyHeight = height - 3 - errorRows.length;
  /** a draft belongs to its conversation, so typing waits for the load or a switch to open one. */
  const composerOpen = (snapshot: Snapshot, leaving: string | undefined) =>
    !!snapshot.conversation &&
    snapshot.conversation.id !== leaving &&
    !['closing', 'error'].includes(snapshot.phase);
  const composerPhase = composerOpen(state, leaving);
  const working = agentWorking(state.phase);
  const entries = [
    ...commands.map(({ id, label, aliases }) => ({
      name: id,
      description: label,
      aliases,
    })),
    ...state.skills.filter(
      ({ name, builtin }) => !builtin && !claimed.has(name),
    ),
  ];
  /** whether the composer holds the prompt ↑/↓ last showed, as shown. */
  const recalled = (
    value: string,
    { index, texts }: ReturnType<typeof unbrowsed>,
    prompts: string[],
  ) => index !== -1 && value === (texts.get(index) ?? prompts[index]);
  const listFor = (
    { value, cursor }: InputBuffer,
    focus: boolean,
    dismissedToken: string | undefined,
    isRecalled: boolean,
  ): List | undefined => {
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
      const items = rankCommands(token.query, entries);
      return items.length ? { kind: 'command', items } : undefined;
    }
    if (token?.kind === 'file') {
      const items = rankFiles(token.query, files);
      return items.length ? { ...token, items } : undefined;
    }
  };
  /** the selection, clamped to a list that may have shrunk since it moved. */
  const selectedIn = (open: List, index: number) =>
    Math.min(index, open.items.length - 1);
  const list = listFor(
    buffer,
    toolFocus,
    dismissed,
    recalled(buffer.value, browsing, prompts),
  );
  const listSelected = list ? selectedIn(list, listIndex) : 0;
  /** keys in one read need the latest completion state before React renders it. */
  const liveListFor = (buffer: InputBuffer) =>
    listFor(
      buffer,
      toolFocusRef.current,
      dismissedRef.current,
      recalled(buffer.value, recall.current, history.current),
    );
  const tools = state.items.filter((item) => item.kind === 'tool');
  const selectedTool = tools[toolSelection];
  const diffHint =
    toolFocus && selectedTool?.diff && canExpandDiff(selectedTool.diff)
      ? diffExpansionHint(fullDiffs.has(selectedTool.id))
      : undefined;
  const listRows = list
    ? Math.min(8, list.items.length, Math.max(1, bodyHeight - 7))
    : toolFocus
      ? 1 + Number(!!diffHint)
      : 0;
  const listFirst = Math.max(0, listSelected - listRows + 1);
  // the composer grows with its text until it would take half the body
  const composerRows = Math.min(
    Math.max(1, Math.floor(bodyHeight / 2)),
    inputRows(buffer.value, composerWidth, true),
  );
  const freeRows = bodyHeight - composerRows - 3 - listRows - (working ? 1 : 0);
  // the transcript keeps two rows
  const queueRows = Math.max(0, Math.min(state.queue.length, freeRows - 2));
  // each shows one row, so a long paste is cleaned once and cut to it rather than on every render
  const queued = useMemo(
    () => state.queue.map((prompt) => oneLine(prompt).slice(0, width)),
    [state.queue, width],
  );
  const availableRows = Math.max(2, freeRows - queueRows);
  const boundary = state.items[contextStart(state.items) - 1];
  const clearedAt = boundary && transcript.starts.get(boundary.id);
  const viewport = (anchor: ScrollAnchor | null) => {
    const row = anchor === null ? Infinity : transcript.rowOf(anchor);
    // decide before the notice takes a row, so hiding the last old row cannot turn it off
    const unpinnedTop = Math.min(
      row,
      Math.max(0, transcript.lines.length - availableRows),
    );
    const pinned = clearedAt !== undefined && unpinnedTop < clearedAt;
    const height = availableRows - Number(pinned);
    const maxTop = Math.max(0, transcript.lines.length - height);
    return { pinned, height, maxTop, top: Math.min(row, maxTop) };
  };
  const { pinned, height: transcriptHeight, top: scrollTop } = viewport(top);
  const scrollTo = (row: number | null) =>
    setTop(row === null ? null : (transcript.anchorAt(row) ?? null));
  /** scrolls from the latest position, so two page keys in one read move two pages. */
  const scrollBy = (rows: number, page = false) =>
    setTop((previous) => {
      const { top, maxTop, height } = viewport(previous);
      const next = Math.min(
        maxTop,
        Math.max(0, top + rows * (page ? height : 1)),
      );
      return next === maxTop ? null : (transcript.anchorAt(next) ?? null);
    });
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
  const request = state.requests[0];
  const busy = working || ['editing', 'closing'].includes(state.phase);

  const run = (operation: Promise<unknown>) => {
    void operation.catch((error: unknown) => coordinator.report(error));
  };
  /** a refusal is a notice, not a report, so it doesn't stop queued prompts; a take can finish after the user has left chat. */
  const changeTask = (operation: Promise<void>) => {
    operation.then(
      () => {
        if (viewRef.current.kind !== 'chat') return;
        setPageScroll(0);
        setView({ kind: 'coordination', mode: 'task' });
      },
      (error: unknown) =>
        coordinator.notice(errorMessage(error), undefined, false),
    );
  };
  /** a switch shows the conversation it leaves until the next one opens, and a prompt sent from it would run in the next one. */
  const leave = (operation: () => Promise<void>) => {
    // one refused for a switch in flight must not reopen the composer
    if (coordinator.snapshot.phase !== 'idle') return run(operation());
    setLeaving(state.conversation?.id);
    run(operation().finally(() => setLeaving(undefined)));
  };
  const picker = (
    title: string,
    entries: Choice[],
    choose: (id: string) => void,
    custom = false,
  ) => {
    pickerInput.current?.set({ value: '', cursor: 0 });
    setQuery('');
    setSelection(0);
    setView({ kind: 'picker', title, choices: entries, choose, custom });
  };
  const showMemory = async () => {
    const memory = await coordinator.memoryView();
    const notes = await coordinator.memory.catalog(
      memory.revision,
      memory.scope,
    );
    const noteChoices = await Promise.all(
      notes.map(async (note) => ({
        id: note.path,
        label: `${note.path}${note.deleted ? ' (deleted)' : ''}`,
        search: note.deleted
          ? ''
          : await coordinator.memory.read(memory.revision, note.path),
        cwd: memory.root,
      })),
    );
    picker(
      'Shared memory',
      [{ id: '+', label: 'Edit project essentials' }, ...noteChoices],
      (file) => {
        if (file === '+') {
          setView({ kind: 'chat' });
          run(coordinator.editMemory());
        } else if (notes.find((note) => note.path === file)?.deleted) {
          showHistory(file);
        } else {
          setPageScroll(0);
          setView({
            kind: 'page',
            title: file,
            text: noteChoices.find((choice) => choice.id === file)!.search,
            link: memory.root && join(memory.root, file),
            note: file,
          });
        }
      },
    );
  };
  const showHistory = (file: string) => {
    run(
      coordinator
        .memoryView()
        .then((memory) => coordinator.memory.history(memory.revision, file))
        .then((history) =>
          picker(
            'Restore a memory version',
            history.map((item) => ({
              id: item.revision,
              label: `${item.revision.slice(0, 8)} ${item.subject}`,
            })),
            (revision) => {
              setView({ kind: 'chat' });
              run(coordinator.restoreMemory(file, revision));
            },
          ),
        ),
    );
  };
  const showJobs = async () => {
    const found = (await jobs?.list()) ?? [];
    picker(
      found.length ? 'Jobs · choose one to stop' : 'No jobs are running',
      found.map((job) => ({
        id: String(job.group),
        label: `${Math.round(job.cpu)}% CPU · ${elapsed(Date.now() - job.startedAt)} · ${job.command}`,
      })),
      (id) => {
        setView({ kind: 'chat' });
        run(jobs!.stop(found.find(({ group }) => String(group) === id)!));
      },
    );
  };
  const selectModel = async (
    id: string,
    effort?: string,
    chooseEffort = false,
  ) => {
    const active = coordinator.snapshot.conversation!.agent;
    const selection = modelTarget(
      id,
      active,
      state.agents.map((agent) => agent.id),
    );
    const efforts =
      coordinator.snapshot.models.find(
        (model) => model.id === selection.id && model.agent === selection.agent,
      )?.efforts ?? [];
    const select = (effort?: string) => {
      setView({ kind: 'chat' });
      if (selection.agent !== active) setTop(null);
      return coordinator.selectModel({ ...selection, effort });
    };
    if (chooseEffort && efforts.length)
      picker(
        `Reasoning for ${selection.id}`,
        [
          {
            id: '',
            label:
              selection.agent === active
                ? 'Keep current effort'
                : `Use ${state.agents.find((agent) => agent.id === selection.agent)!.label}'s current/default effort`,
          },
          ...efforts.map((effort) => ({ id: effort, label: effort })),
        ],
        (effort) => run(select(effort || undefined)),
      );
    else await select(effort);
  };
  const command = (name: string, argument = '') => {
    setView({ kind: 'chat' });
    switch (name) {
      case 'new':
        leave(() => coordinator.newConversation(argument || undefined));
        break;
      case 'sessions':
        run(
          coordinator.conversations().then((conversations) =>
            picker(
              'Conversations',
              conversations.map((conversation) => ({
                id: conversation.id,
                label: `${conversation.title} · ${conversation.agent}`,
                cwd: conversation.cwd,
              })),
              (id) => {
                setView({ kind: 'chat' });
                setTop(null);
                leave(() => coordinator.selectConversation(id));
              },
            ),
          ),
        );
        break;
      case 'peers':
        setPageScroll(0);
        setView({ kind: 'coordination', mode: 'peers' });
        break;
      case 'task':
        if (argument === 'release') {
          changeTask(coordinator.releaseTask());
          break;
        }
        if (/^take\s+\S/.test(argument)) {
          changeTask(coordinator.takeTask(argument.slice(4).trim()));
          break;
        }
        if (argument) {
          coordinator.notice(
            'Use /task, /task release or /task take <reference>.',
            undefined,
            false,
          );
          break;
        }
        setPageScroll(0);
        setView({ kind: 'coordination', mode: 'task' });
        break;
      case 'model':
        if (argument) {
          const [id, effort] = argument.split(/\s+/);
          run(selectModel(id!, effort));
        } else
          run(
            coordinator.refreshModels().then((refreshed) => {
              if (!refreshed) return;
              picker(
                'Models · type an ID or choose one',
                coordinator.snapshot.models.map((model) => ({
                  id: modelKey(model),
                  label: `${state.agents.find((agent) => agent.id === model.agent)!.label} · ${model.label}`,
                  exact: model.id,
                })),
                (id) => run(selectModel(id, undefined, true)),
                true,
              );
            }),
          );
        break;
      case 'compact':
        if (argument)
          coordinator.notice(
            'Use /compact without arguments.',
            undefined,
            false,
          );
        else run(coordinator.compact());
        break;
      case 'clear':
        if (argument)
          coordinator.notice('Use /clear without arguments.', undefined, false);
        else run(coordinator.clear());
        break;
      case 'memory':
        run(showMemory());
        break;
      case 'jobs':
        run(showJobs());
        break;
      case 'help':
        setPageScroll(0);
        setView({
          kind: 'page',
          title: 'Keyboard help',
          text: `${commands.map(({ id, label, aliases = [] }) => `${[id, ...aliases].map((name) => `/${name}`).join(', ')}  ${label}`).join('\n')}\n\nEnter sends. Shift+Enter inserts a newline. Pasted newlines never send.\nCmd+←/→ go to the start or end of the wrapped row, and Option+←/→ move by word. Cmd+Delete deletes to the start of the wrapped row, Option+Delete the word before the cursor, and Fn+Option+Delete the word after it. Ctrl+A, Ctrl+E and Ctrl+U work as Cmd+←, Cmd+→ and Cmd+Delete, and Option+B and Option+F as Option+←/→.\nA message that starts with ! runs the rest as a shell command in this directory, without a sandbox, and the agent then replies to it. One sent while the agent works waits until the agent finishes, unless the agent has replied while familiars or workflows still run and nothing but a spell or native command is waiting, when it runs at once.\nWhile the agent works, Enter passes a message into its turn, or queues it for the next one, which still runs after an ordinary turn is interrupted. Cancelled or failed compaction leaves queued messages undelivered. ↑ on the first line takes queued messages back to edit, or with none queued shows the prompt sent before, from any conversation in this directory. ↓ on the last line goes back to newer prompts and the draft.\nCtrl+P opens commands. PageUp/PageDown and the mouse wheel scroll.\nType / for commands and spells, or @ for files. In that list, ↑/↓ choose, Tab completes, Enter runs a command or inserts a file, and Escape closes it.\nWith no list open, Tab selects tool results; ↑/↓ choose a tool, Enter expands or collapses it. Ctrl+O switches new or deleted files between their preview and all lines.\nEnd returns to live output while tools are focused.\nWith no list open, Escape closes a view, then leaves tool focus, then interrupts execution.\nOn a request, Escape declines it and the turn continues. Ctrl+O switches new or deleted files between their preview and all lines.\nCtrl+C interrupts active work or cancels a pending question. It exits while idle with no request, and quits at once while closing.\n\nClick web links to open your browser.\nClick file paths to open VS Code at their line and column.\nDrag selects transcript text, and Cmd+C copies it.\nShift+drag selects as the terminal does.\n\n/model <id> [effort] selects a model on the active runtime.\n/model <agent>:<id> [effort] selects a runtime and model; choosing another runtime performs a handoff.\n\nIn memory: e edits the note in VS Code; h shows its history.\nClose the VS Code file to finish editing and commit its changes.`,
        });
        break;
      case 'restart':
        onRestart?.();
        break;
      case 'exit':
        onExit();
        break;
    }
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

  const submit = (text: string): boolean => {
    // Enter while tools are focused toggles a tool, and one the composer would refuse keeps the draft, even in the
    // same read as the Tab or switch before it. a lone `!` has no command to run
    if (
      toolFocusRef.current ||
      !composerOpen(coordinator.snapshot, leavingRef.current) ||
      /^!\s*$/.test(text)
    )
      return false;
    const match = /^\/(\S+)(?:\s+(.*))?$/s.exec(text.trim());
    const found =
      match &&
      commands.find(
        ({ id, aliases }) => id === match[1] || aliases?.includes(match[1]!),
      );
    if (found) {
      remember(text);
      command(found.id, match[2]);
      return true;
    }
    setTop(null);
    // a prompt sent while the load connects would otherwise run ahead of the one Witch started with
    const initial = pendingPrompt.current;
    pendingPrompt.current = undefined;
    if (initial !== undefined) submit(initial);
    remember(text);
    run(coordinator.send(text));
    return true;
  };

  /** puts text back ahead of the draft, with the cursor after the text while the composer shows; it ends browsing, so the draft is the one typed before it. */
  const prepend = (text: string) => {
    const id = state.conversation?.id ?? '';
    const { index, texts } = recall.current;
    const draft = index === -1 ? draftsRef.current[id] : texts.get(-1);
    setRecall(unbrowsed());
    const value = draft ? `${text}\n${draft}` : text;
    if (composer.current) composer.current.set({ value, cursor: text.length });
    else setDraft(id, value);
  };
  /** puts the queue back ahead of the draft, as Claude Code's ↑ does. */
  const unqueue = () => {
    if (!coordinator.snapshot.queue.length) return false;
    prepend(coordinator.unqueue().join('\n'));
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

  /** writes the selected entry into the draft: `/name ` replaces it, `@path ` replaces its token and a space already after it. */
  const complete = (open: List) => {
    const index = selectedIn(open, listIndexRef.current);
    const { value } = bufferRef.current;
    if (open.kind === 'command') {
      const text = `/${open.items[index]!.name} `;
      composer.current?.set({ value: text, cursor: text.length });
    } else {
      const text = `@${open.items[index]!} `;
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
    toolFocusRef.current ||
    moveInList(direction, current) ||
    (direction === 'up'
      ? !current.value.slice(0, current.cursor).includes('\n') &&
        (unqueue() || browse('up', current))
      : !current.value.slice(current.cursor).includes('\n') &&
        browse('down', current));
  /** Enter runs the selected command or skill, and inserts a file without sending; a send starts browsing again at the newest. */
  const submitComposer = (text: string) => {
    const open = liveListFor(bufferRef.current);
    if (open?.kind === 'file') {
      complete(open);
      return false;
    }
    const accepted = submit(
      open
        ? `/${open.items[selectedIn(open, listIndexRef.current)]!.name}`
        : text,
    );
    if (accepted) setRecall(unbrowsed());
    return accepted;
  };

  useEffect(() => {
    setTop(null);
    setToolSelection(0);
    setFullDiffs(new Set());
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
  }, [state.phase, state.queue]);
  const recoveryReady = useKeysReady(state.phase === 'recovery');
  useEffect(() => {
    if (state.phase === 'recovery') setPageScroll(0);
  }, [state.phase]);

  const recovering = state.phase === 'recovery';
  const recovery = recovering ? state.recovery : undefined;
  const conflict = recovery?.kind === 'conflict';
  const pageView = recovering ? undefined : view;
  const pageCoordination =
    pageView?.kind === 'coordination' ? coordination : undefined;
  const pageLines = useMemo(() => {
    const pageText = recovering
      ? linkify(
          conflict
            ? `${recovery.paths.length ? `Conflicting paths:\n${recovery.paths.map(plain).join('\n')}` : 'This conflict has no single path.'}\n\nCommit that could not be published:\n${recovery.diff}`
            : (recovery?.diff ?? ''),
          recovery?.root ?? cwd,
        )
      : pageView?.kind === 'page'
        ? markdown(
            pageView.text,
            cwd,
            pageView.note === undefined
              ? cwd
              : pageView.link
                ? dirname(pageView.link)
                : null,
          )
        : pageView?.kind === 'coordination'
          ? coordinationText(pageCoordination, pageView.mode)
          : '';
    return wrapLines(pageText, bodyWidth);
  }, [
    recovering,
    recovery,
    conflict,
    cwd,
    pageView,
    pageCoordination,
    bodyWidth,
  ]);
  const pageRows = Math.max(1, bodyHeight - (recovering ? 5 : 3));
  usePointer((pointer, { column, row }) => {
    // a press or release ends the drag even while another view covers the transcript
    if (pointer !== 'drag') pressedAt.current = undefined;
    if (pointer === 'press') setRange(undefined);
    if (!transcriptBox.current) return;
    const box = measureElement(transcriptBox.current);
    // reports in one read arrive before a render, so each starts where the last one scrolled
    const {
      top: first,
      height,
      pinned: currentPinned,
    } = viewport(topRef.current);
    const shown = Math.min(height, transcript.lines.length - first);
    // a queued scroll can move the notice before Ink moves the content box
    const origin = box.y + Number(currentPinned) - Number(pinned);
    // past the top or bottom, the row a drag scrolls in
    const offset = Math.max(-1, Math.min(shown, row - origin));
    const at = Math.max(
      0,
      Math.min(transcript.lines.length - 1, first + offset),
    );
    const anchor = transcript.anchorAt(at);
    const end = anchor && {
      anchor,
      column: Math.max(0, Math.min(bodyWidth - 1, column - box.x)),
      width,
      text: transcript.lines.at(at)!,
    };
    if (pointer === 'press') {
      if (offset >= 0 && offset < shown && column < box.x + bodyWidth)
        pressedAt.current = end;
    } else if (pressedAt.current && end) {
      if (offset < 0 || offset === shown) scrollBy(offset < 0 ? -1 : 1);
      setRange({ from: pressedAt.current, to: end });
    }
  });
  useWheel((rows) => {
    if (!request && !recovering && view.kind === 'chat') scrollBy(rows);
  });

  useInput((input, key) => {
    if (key.eventType === 'release') return;
    if (key.ctrl && input === 'c') {
      // a second Ctrl+C while closing quits without waiting for the agent
      if ((busy || request) && state.phase !== 'closing')
        run(coordinator.interrupt());
      else onExit();
      return;
    }
    if (key.super && input === 'c') {
      // nothing copies while another view covers the transcript, and blank rows or images hold no text to replace the clipboard with
      const selected = endsOf(rangeRef.current);
      const text =
        transcriptBox.current &&
        selected &&
        selectedText(transcript.lines, ...selected, joint);
      if (text?.trim()) copy?.(text);
      return;
    }
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
      if (view.kind !== 'chat') setView({ kind: 'chat' });
      else if (toolFocusRef.current) setToolFocus(false);
      else if (busy || state.phase === 'cleaning') run(coordinator.interrupt());
      return;
    }
    if (key.ctrl && input === 'p') {
      picker('Commands', commands, (id) => command(id));
      return;
    }
    if (view.kind === 'picker') {
      const current = Math.min(
        selectionRef.current,
        Math.max(0, choices.length - 1),
      );
      if (key.upArrow) setSelection(Math.max(0, current - 1));
      if (key.downArrow)
        setSelection(Math.max(0, Math.min(choices.length - 1, current + 1)));
      return;
    }
    if (view.kind === 'page' || view.kind === 'coordination') {
      if (view.kind === 'page' && view.note && !modified) {
        if (input === 'e') {
          setView({ kind: 'chat' });
          run(coordinator.editMemory(view.note));
        }
        if (input === 'h') {
          showHistory(view.note);
        }
      }
      return;
    }
    if (key.pageUp) scrollBy(-1, true);
    if (key.pageDown) scrollBy(1, true);
    if (key.tab) setToolFocus(!toolFocusRef.current);
    if (toolFocusRef.current) {
      const current = toolSelectionRef.current;
      let next = current;
      if (key.upArrow) next = Math.max(0, current - 1);
      if (key.downArrow)
        next = Math.max(0, Math.min(tools.length - 1, current + 1));
      if (next !== current) {
        setToolSelection(next);
        scrollTo(transcript.starts.get(tools[next]?.id ?? '') ?? null);
      }
      if (key.end) setTop(null);
      if (key.ctrl && input === 'o') {
        const item = tools[next];
        if (item?.diff && canExpandDiff(item.diff)) {
          setFullDiffs((previous) => {
            const full = new Set(previous);
            if (full.has(item.id)) full.delete(item.id);
            else full.add(item.id);
            return full;
          });
          setExpanded((previous) => new Map(previous).set(item.id, true));
          scrollTo(transcript.starts.get(item.id) ?? null);
        }
      }
      if (key.return && tools[next]) {
        const item = tools[next]!;
        setExpanded((previous) =>
          new Map(previous).set(item.id, !isExpanded(item, previous)),
        );
      }
    }
  });

  const model = state.native?.model;
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
      <Box flexDirection="column" height={bodyHeight}>
        <Text color="yellow" bold>
          {conflict
            ? 'Memory conflicts with another conversation'
            : 'Unfinished memory changes'}
        </Text>
        <Text>
          {conflict
            ? 'Another conversation published changes to the same notes. Keep mine merges your current changes.'
            : 'Accept these changes with their original attribution, or discard them.'}
        </Text>
        <ScrollPage
          lines={pageLines}
          height={pageRows}
          scroll={pageScroll}
          setScroll={setPageScroll}
          arrows
        />
        <Text bold>
          {piped([
            ...(conflict
              ? [
                  'k KEEP MINE (YOUR SIDE OF EACH CONFLICTING CHANGE WINS)',
                  'd DISCARD MINE',
                ]
              : ['a ACCEPT', 'd DISCARD']),
            '↑/↓ SCROLL',
            'CTRL+C QUIT',
          ])}
        </Text>
      </Box>
    );
  } else if (view.kind === 'picker') {
    const count = Math.max(1, bodyHeight - 4);
    const first = Math.max(0, selected - count + 1);
    body = (
      <Box flexDirection="column" height={bodyHeight}>
        <Text bold>{plain(view.title)}</Text>
        <Box height={count} flexDirection="column" overflow="hidden">
          {choices.slice(first, first + count).map((choice, index) => {
            // a note name can hold a line break
            const label = ` ${oneLine(choice.label)} `;
            return (
              <Text
                key={choice.id}
                inverse={first + index === selected}
                wrap="truncate-end"
              >
                {choice.cwd ? linkify(label, choice.cwd) : label}
              </Text>
            );
          })}
        </Box>
        <Input
          ref={pickerInput}
          key={view.title}
          width={bodyWidth}
          height={1}
          active
          multiline={false}
          placeholder="Filter, then Enter"
          onChange={(text) => {
            setQuery(text);
            setSelection(0);
          }}
          onSubmit={(text) => {
            // the filter and selection a read changed are not rendered yet
            const matching = filter(view.choices, text);
            const choice =
              matching[Math.min(selectionRef.current, matching.length - 1)];
            if (choice) view.choose(choice.id);
            else if (view.custom && text.trim()) view.choose(text.trim());
            else return false;
            return true;
          }}
        />
        <Text dimColor>
          {piped(['↑/↓ CHOOSE', 'ENTER SELECT', 'ESC BACK'])}
        </Text>
      </Box>
    );
  } else if (view.kind === 'page' || view.kind === 'coordination') {
    // a note's file name is agent-written and can hold a line break, and Ink keeps OSC 8 links
    const title =
      view.kind === 'page'
        ? oneLine(view.title)
        : view.mode === 'peers'
          ? 'Repository sessions'
          : 'Current task';
    body = (
      <Box flexDirection="column" height={bodyHeight}>
        <Text bold>
          {view.kind === 'page' && view.link
            ? hyperlink(title, view.link, cwd)
            : title}
        </Text>
        <ScrollPage
          lines={pageLines}
          height={pageRows}
          scroll={pageScroll}
          setScroll={setPageScroll}
          arrows
        />
        <Text dimColor>
          {piped([
            ...(view.kind === 'page' && view.note
              ? ['e EDIT', 'h HISTORY']
              : []),
            '↑/↓ SCROLL',
            'ESC BACK',
          ])}
        </Text>
      </Box>
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
        row - scrollTop < visible.length
      )
        visible[row - scrollTop] = castTitle(frame);
    }
    const selectedToolRow = transcript.starts.get(
      tools[toolSelection]?.id ?? '',
    );
    if (
      toolFocus &&
      selectedToolRow !== undefined &&
      selectedToolRow >= scrollTop &&
      selectedToolRow < scrollTop + transcriptHeight
    )
      visible[selectedToolRow - scrollTop] = colors.inverse(
        visible[selectedToolRow - scrollTop],
      );
    if (ends) {
      const [start, end] = ends;
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
        {queueRows > 0 && (
          <Box height={queueRows} flexDirection="column" overflow="hidden">
            {queued.slice(0, queueRows).map((prompt, index) => (
              <Text key={index} dimColor wrap="truncate-end">
                {`❯ ${prompt}`}
              </Text>
            ))}
          </Box>
        )}
        {working && <Activity />}
        <Box
          borderStyle="bold"
          borderColor={
            toolFocus ? 'gray' : buffer.value.startsWith('!') ? potion : accent
          }
          height={composerRows + 2}
          paddingX={1}
        >
          <Input
            // Input reads its initial value only when it mounts
            key={state.conversation?.id ?? 'initial'}
            width={composerWidth}
            height={composerRows}
            shell
            active={!toolFocus && composerPhase}
            ref={composer}
            initialValue={drafts[state.conversation?.id ?? ''] ?? ''}
            placeholder={
              state.queue.length ? 'Press ↑ to edit queued messages' : undefined
            }
            onChange={changeComposer}
            onSubmit={submitComposer}
            onArrow={arrow}
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
          toolFocus && (
            <Box flexDirection="column">
              <Text dimColor>
                {piped([
                  '↑/↓ TOOLS',
                  'ENTER TOGGLE',
                  'TAB COMPOSE',
                  'END LIVE OUTPUT',
                  'ESC LEAVE TOOLS',
                ])}
              </Text>
              {diffHint && <Text dimColor>{diffHint}</Text>}
            </Box>
          )
        )}
      </Box>
    );
  }
  return (
    <Box width={columns} height={height}>
      <Box flexDirection="column" width={width} height={height}>
        <Box height={1}>
          <Text dimColor>
            {piped([
              state.phase.toUpperCase(),
              ...(state.native?.permissionMode
                ? [plain(state.native.permissionMode).toUpperCase()]
                : []),
              ...(top !== null && view.kind === 'chat'
                ? ['READING EARLIER OUTPUT']
                : []),
              ...(state.phase === 'editing'
                ? ['CLOSE THE VS CODE FILE TO FINISH']
                : []),
            ])}
          </Text>
        </Box>
        <Box flexDirection="column" paddingX={1}>
          {body}
        </Box>
        {errorRows.length > 0 && (
          <Box height={errorRows.length} paddingX={1} overflow="hidden">
            <Text color="red">{errorRows.join('\n')}</Text>
          </Box>
        )}
        <StatusLine
          width={width}
          {...(usageInSidebar
            ? {}
            : {
                limits: live ? state.limits[live] : undefined,
                others: accounts.filter(({ id }) => id !== live),
              })}
          model={
            state.models.find(
              ({ id, agent }) =>
                id === model &&
                agent === (state.native?.agent ?? state.conversation?.agent),
            )?.label ?? model
          }
          effort={state.native?.effort ?? state.native?.nativeEffort}
          usage={state.usage}
          openedAt={state.openedAt}
          cwd={cwd}
          repository={repositoryStatus}
        />
      </Box>
      {sidebar && (
        <Sidebar
          height={height}
          activity={coordinator.pentacle}
          brews={state.backgroundCommands}
          subagents={state.subagents}
          peers={coordination?.peers}
          accounts={usageInSidebar ? accounts : []}
        />
      )}
    </Box>
  );
}
