import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import type { Key } from 'ink';
import { basename, join } from 'node:path';
import stripAnsi from 'strip-ansi';
import wrapAnsi from 'wrap-ansi';
import type { Skill } from '../agents/types.js';
import type { Coordinator } from '../core/coordinator.js';
import { Input } from './input.js';
import type { InputHandle } from './input.js';
import type { InputBuffer } from './input-buffer.js';
import {
  activeToken,
  rankCommands,
  rankFiles,
  tokenKey,
} from './completion.js';
import { Request } from './request.js';
import { TranscriptLayout } from './transcript-layout.js';
import type { ScrollAnchor } from './transcript-layout.js';
import { colors, markdown } from './markdown.js';
import { hyperlink, linkify } from './links.js';
import { useLiveState } from './live-state.js';

const commands: { id: string; label: string; aliases?: string[] }[] = [
  { id: 'new', label: 'New conversation' },
  { id: 'sessions', label: 'Saved conversations' },
  { id: 'agent', label: 'Switch agent' },
  { id: 'model', label: 'Choose model and reasoning' },
  { id: 'memory', label: 'Browse shared memory' },
  { id: 'help', label: 'Keyboard help' },
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
  cwd?: string;
}
type View =
  | { kind: 'chat' }
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

export function App({
  coordinator,
  onExit,
  initialPrompt,
}: {
  coordinator: Coordinator;
  onExit(): void;
  /** sent once the load ends idle with nothing reported, otherwise left as the draft. */
  initialPrompt?: string;
}) {
  const subscription = useMemo(
    () => (notify: () => void) => {
      let scheduled: ReturnType<typeof setTimeout> | undefined;
      const unsubscribe = coordinator.subscribe(() => {
        scheduled ??= setTimeout(() => {
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
  const size = useWindowSize();
  const width = Math.max(30, size.columns);
  const height = Math.max(12, size.rows);
  const cwd = state.conversation?.cwd ?? process.cwd();
  const [view, setView] = useState<View>({ kind: 'chat' });
  const [query, setQuery] = useState('');
  const [selection, selectionRef, setSelection] = useLiveState(0);
  const [pageScroll, setPageScroll] = useState(0);
  const [top, setTop] = useState<ScrollAnchor | null>(null);
  const [toolFocus, toolFocusRef, setToolFocus] = useLiveState(false);
  const [toolSelection, toolSelectionRef, setToolSelection] = useLiveState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // a send resolves after later renders, so it reads the live drafts
  const draftsRef = useRef(drafts);
  const setDraft = (id: string, value: string) => {
    draftsRef.current = { ...draftsRef.current, [id]: value };
    setDrafts(draftsRef.current);
  };
  // Input reads its initial value only when it mounts
  const [composerKey, setComposerKey] = useState(0);
  const composer = useRef<InputHandle>(null);
  const [buffer, bufferRef, setBuffer] = useLiveState<InputBuffer>({
    value: '',
    cursor: 0,
  });
  const [, listIndexRef, setListIndex] = useLiveState(0);
  const [, dismissedRef, setDismissed] = useLiveState<string | undefined>(
    undefined,
  );
  const [files, setFiles] = useState<string[]>([]);
  const pendingPrompt = useRef(initialPrompt);
  const [layout] = useState(() => new TranscriptLayout());
  const transcript = useMemo(
    () => layout.render(state.items, width - 2, expanded),
    [layout, state.items, width, expanded],
  );
  const errorLimit = Math.max(1, Math.floor(height / 3));
  const errorLines = state.error
    ? wrapAnsi(linkify(state.error, cwd), width - 2, {
        hard: true,
        trim: false,
      }).split('\n')
    : [];
  const errorRows =
    errorLines.length > errorLimit
      ? [
          ...errorLines.slice(0, errorLimit - 1),
          `+${errorLines.length - errorLimit + 1} more rows`,
        ]
      : errorLines;
  const bodyHeight = height - 3 - errorRows.length;
  const composerPhase = !['starting', 'closing', 'error'].includes(state.phase);
  const entries = [
    ...commands.map(({ id, label, aliases }) => ({
      name: id,
      description: label,
      aliases,
    })),
    ...state.skills.filter(({ name }) => !claimed.has(name)),
  ];
  /** read at key time from the live buffer, since several keys can arrive in one read. */
  const listFor = ({ value, cursor }: InputBuffer): List | undefined => {
    if (
      view.kind !== 'chat' ||
      !composerPhase ||
      toolFocusRef.current ||
      dismissedRef.current === tokenKey(value, cursor)
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
  const selectedIn = (open: List) =>
    Math.min(listIndexRef.current, open.items.length - 1);
  const list = listFor(buffer);
  const listSelected = list ? selectedIn(list) : 0;
  const listRows = list
    ? Math.min(8, list.items.length, Math.max(1, bodyHeight - 7))
    : 1;
  const listFirst = Math.max(0, listSelected - listRows + 1);
  const transcriptHeight = Math.max(2, bodyHeight - 6 - listRows);
  const maxTop = Math.max(0, transcript.lines.length - transcriptHeight);
  const scrollTop =
    top === null ? maxTop : Math.min(transcript.rowOf(top), maxTop);
  const scrollTo = (row: number | null) =>
    setTop(row === null ? null : (transcript.anchorAt(row) ?? null));
  /** scrolls from the latest position, so two page keys in one read move two pages. */
  const scrollBy = (rows: number) =>
    setTop((previous) => {
      const current =
        previous === null
          ? maxTop
          : Math.min(transcript.rowOf(previous), maxTop);
      const next = Math.min(maxTop, Math.max(0, current + rows));
      return next === maxTop ? null : (transcript.anchorAt(next) ?? null);
    });
  const tools = state.items.filter((item) => item.kind === 'tool');
  /** an exact ID goes first, so Enter never picks a longer ID that contains it. */
  const filter = (entries: Choice[], text: string) =>
    entries
      .filter((choice) =>
        `${choice.label} ${choice.id} ${choice.search ?? ''}`
          .toLowerCase()
          .includes(text.toLowerCase()),
      )
      .sort(
        (a, b) => Number(b.id === text.trim()) - Number(a.id === text.trim()),
      );
  const choices = view.kind === 'picker' ? filter(view.choices, query) : [];
  const selected = Math.min(selection, Math.max(0, choices.length - 1));
  const request = state.requests[0];
  const busy = [
    'starting',
    'running',
    'switching',
    'editing',
    'closing',
  ].includes(state.phase);

  const run = (operation: Promise<unknown>) => {
    void operation.catch((error: unknown) => coordinator.report(error));
  };
  const picker = (
    title: string,
    entries: Choice[],
    choose: (id: string) => void,
    custom = false,
  ) => {
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
  const selectModel = (id: string) => {
    const efforts =
      coordinator.snapshot.models.find((model) => model.id === id)?.efforts ??
      [];
    if (efforts.length)
      picker(
        `Reasoning for ${id}`,
        [
          { id: '', label: 'Keep current effort' },
          ...efforts.map((effort) => ({ id: effort, label: effort })),
        ],
        (effort) => {
          setView({ kind: 'chat' });
          run(coordinator.selectModel(id, effort || undefined));
        },
      );
    else {
      setView({ kind: 'chat' });
      run(coordinator.selectModel(id));
    }
  };
  const command = (name: string, argument = '') => {
    setView({ kind: 'chat' });
    switch (name) {
      case 'new':
        run(coordinator.newConversation(argument || undefined));
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
                run(coordinator.selectConversation(id));
              },
            ),
          ),
        );
        break;
      case 'agent':
        if (argument) {
          setTop(null);
          run(coordinator.switchAgent(argument));
        } else
          picker(
            'Installed agents',
            state.agents.map((agent) => ({
              id: agent.id,
              label: `${agent.label}${agent.installed ? '' : ' (not installed)'}`,
            })),
            (id) => command('agent', id),
          );
        break;
      case 'model':
        if (argument) {
          const [id, effort] = argument.split(/\s+/);
          run(coordinator.selectModel(id!, effort));
        } else
          run(
            coordinator.refreshModels().then(() =>
              picker(
                'Models · type an ID or choose one',
                coordinator.snapshot.models.map((model) => ({
                  id: model.id,
                  label: model.label,
                })),
                selectModel,
                true,
              ),
            ),
          );
        break;
      case 'memory':
        run(showMemory());
        break;
      case 'help':
        setPageScroll(0);
        setView({
          kind: 'page',
          title: 'Keyboard help',
          text: `${commands.map(({ id, label, aliases = [] }) => `${[id, ...aliases].map((name) => `/${name}`).join(', ')}  ${label}`).join('\n')}\n\nEnter sends. Shift+Enter inserts a newline. Pasted newlines never send.\nCtrl+P opens commands. PageUp/PageDown scroll.\nType / for commands and skills, or @ for files. In that list, ↑/↓ choose, Tab completes, Enter runs a command or inserts a file, and Escape closes it.\nWith no list open, Tab selects tool results; ↑/↓ choose a tool, Enter expands it.\nEnd returns to live output while tools are focused.\nWith no list open, Escape closes a view, then leaves tool focus, then interrupts execution.\nOn a request, Escape declines it and the turn continues.\nCtrl+C interrupts active work or exits while idle, and quits at once while closing.\n\nCmd+click web links to open your browser.\nCmd+click file paths to open VS Code at their line and column.\n\n/model <id> [effort] selects an explicit model.\n/agent <id> switches agents with a handoff.\n\nIn memory: e edits the note in VS Code; h shows its history.\nClose the VS Code file to finish editing and commit its changes.`,
        });
        break;
      case 'exit':
        onExit();
        break;
    }
  };

  const submit = (text: string): boolean => {
    // Enter while tools are focused expands a tool, even in the same read as Tab
    if (toolFocusRef.current) return false;
    const match = /^\/(\S+)(?:\s+(.*))?$/.exec(text.trim());
    const found =
      match &&
      commands.find(
        ({ id, aliases }) => id === match[1] || aliases?.includes(match[1]!),
      );
    if (found) {
      command(found.id, match[2]);
      return true;
    }
    if (coordinator.snapshot.phase !== 'idle') {
      coordinator.report(
        'Wait for this operation to finish, or press Escape to interrupt.',
      );
      return false;
    }
    setTop(null);
    const id = coordinator.snapshot.conversation?.id ?? '';
    // a prompt the agent never got comes back, unless a new draft took its place
    void coordinator.send(text).then(
      (delivered) => {
        if (delivered || draftsRef.current[id]) return;
        setDraft(id, text);
        setComposerKey((key) => key + 1);
      },
      (error: unknown) => coordinator.report(error),
    );
    return true;
  };

  /** writes the selected entry into the draft: `/name ` replaces it, `@path ` replaces only its token. */
  const complete = (open: List) => {
    const index = selectedIn(open);
    const { value } = bufferRef.current;
    if (open.kind === 'command') {
      const text = `/${open.items[index]!.name} `;
      composer.current?.set({ value: text, cursor: text.length });
    } else {
      const text = `@${open.items[index]!} `;
      composer.current?.set({
        value: value.slice(0, open.start) + text + value.slice(open.end),
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
    const open = listFor(current);
    if (!open) return false;
    const index = selectedIn(open);
    setListIndex(
      direction === 'up'
        ? Math.max(0, index - 1)
        : Math.min(open.items.length - 1, index + 1),
    );
    return true;
  };
  /** Enter runs the selected command or skill, and inserts a file without sending. */
  const submitComposer = (text: string) => {
    const open = listFor(bufferRef.current);
    if (!open) return submit(text);
    if (open.kind === 'file') {
      complete(open);
      return false;
    }
    return submit(`/${open.items[selectedIn(open)]!.name}`);
  };

  useEffect(() => {
    setTop(null);
    setToolSelection(0);
  }, [state.conversation?.id]);
  useEffect(() => {
    const prompt = pendingPrompt.current;
    if (prompt === undefined || state.phase === 'starting') return;
    pendingPrompt.current = undefined;
    if (state.phase === 'idle' && !state.error) submit(prompt);
    else {
      setDraft(state.conversation?.id ?? '', prompt);
      setComposerKey((key) => key + 1);
    }
  }, [state.phase]);
  useEffect(() => {
    if (state.phase === 'recovery') setPageScroll(0);
  }, [state.phase]);

  const recovery = state.recovery;
  const conflict = recovery?.kind === 'conflict';
  const pageText =
    state.phase === 'recovery'
      ? linkify(
          conflict
            ? `${recovery.paths.length ? `Conflicting paths:\n${recovery.paths.join('\n')}` : 'This conflict has no single path.'}\n\nYour changes:\n${recovery.diff}`
            : (recovery?.diff ?? ''),
          recovery?.root ?? cwd,
        )
      : view.kind === 'page'
        ? markdown(view.text, cwd)
        : '';
  const pageLines = wrapAnsi(pageText, width - 2, {
    hard: true,
    trim: false,
  }).split('\n');
  const pageRows = Math.max(
    1,
    bodyHeight - (state.phase === 'recovery' ? 5 : 3),
  );
  const pageLast = Math.max(0, pageLines.length - pageRows);
  const pageTop = Math.min(pageScroll, pageLast);
  /** steps from the shown top, so a key past either end moves the page at once. */
  const scrollPage = (key: Key) => {
    const rows = key.pageDown
      ? pageRows
      : key.downArrow
        ? 1
        : key.pageUp
          ? -pageRows
          : key.upArrow
            ? -1
            : 0;
    if (rows)
      setPageScroll((value) =>
        Math.max(0, Math.min(pageLast, Math.min(value, pageLast) + rows)),
      );
  };

  useInput((input, key) => {
    if (key.eventType === 'release') return;
    if (key.ctrl && input === 'c') {
      // a second Ctrl+C while closing quits without waiting for the agent
      if (busy && state.phase !== 'closing') run(coordinator.interrupt());
      else onExit();
      return;
    }
    if (request) return;
    if (state.phase === 'recovery') {
      scrollPage(key);
      const kind = recovery?.kind;
      if (input === 'd') run(coordinator.recoverMemory('discard'));
      if (input === 'a' && kind === 'pending')
        run(coordinator.recoverMemory('accept'));
      if (input === 'k' && kind === 'conflict')
        run(coordinator.recoverMemory('keep'));
      return;
    }
    const open = listFor(bufferRef.current);
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
      else if (busy) run(coordinator.interrupt());
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
    if (view.kind === 'page') {
      scrollPage(key);
      if (view.note) {
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
    if (key.pageUp) scrollBy(-transcriptHeight);
    if (key.pageDown) scrollBy(transcriptHeight);
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
      if (key.return && tools[next]) {
        const id = tools[next]!.id;
        setExpanded((previous) => {
          const next = new Set(previous);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      }
    }
  });

  const header = `${hyperlink(basename(cwd), cwd, cwd)}  ·  ${state.conversation?.agent ?? 'Starting'}  ·  ${state.native?.model || state.conversation?.sessions[state.conversation.agent]?.model || 'Native default'}`;
  let body;
  if (request)
    body = (
      <Request
        key={request.id}
        request={request}
        width={width - 2}
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
            ? 'Another conversation published changes to the same notes.'
            : 'Accept these changes with their original attribution, or discard them.'}
        </Text>
        <Box height={pageRows} overflow="hidden">
          <Text>{pageLines.slice(pageTop, pageTop + pageRows).join('\n')}</Text>
        </Box>
        <Text bold>
          {conflict
            ? 'k keep mine (your side of each conflicting change wins) · d discard mine'
            : 'a accept · d discard'}{' '}
          · ↑/↓ scroll · Ctrl+C quit
        </Text>
      </Box>
    );
  } else if (view.kind === 'picker') {
    const count = Math.max(1, bodyHeight - 4);
    const first = Math.max(0, selected - count + 1);
    body = (
      <Box flexDirection="column" height={bodyHeight}>
        <Text bold>{view.title}</Text>
        <Box height={count} flexDirection="column" overflow="hidden">
          {choices.slice(first, first + count).map((choice, index) => (
            <Text key={choice.id} inverse={first + index === selected}>
              {choice.cwd
                ? linkify(` ${choice.label} `, choice.cwd)
                : ` ${choice.label} `}
            </Text>
          ))}
        </Box>
        <Input
          key={view.title}
          width={width - 2}
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
        <Text dimColor>↑/↓ choose · Enter select · Esc back</Text>
      </Box>
    );
  } else if (view.kind === 'page') {
    body = (
      <Box flexDirection="column" height={bodyHeight}>
        <Text bold>
          {view.link ? hyperlink(view.title, view.link, cwd) : view.title}
        </Text>
        <Box height={pageRows} overflow="hidden">
          <Text>{pageLines.slice(pageTop, pageTop + pageRows).join('\n')}</Text>
        </Box>
        <Text dimColor>
          {view.note ? 'e edit · h history · ' : ''}↑/↓ scroll · Esc back
        </Text>
      </Box>
    );
  } else {
    const visible = transcript.lines.slice(
      scrollTop,
      scrollTop + transcriptHeight,
    );
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
    body = (
      <Box flexDirection="column" height={bodyHeight}>
        <Box height={transcriptHeight} overflow="hidden">
          <Text>
            {state.items.length
              ? visible.join('\n')
              : colors.dim(
                  'Start a conversation. Use /agent to choose Codex or Claude Code.\nShared memory carries verified preferences between conversations.\nCtrl+P opens commands; /help lists keyboard controls.',
                )}
          </Text>
        </Box>
        <Box
          borderStyle="round"
          borderColor={toolFocus ? 'gray' : 'cyan'}
          height={5}
          paddingX={1}
        >
          <Input
            key={`${state.conversation?.id ?? 'initial'}/${composerKey}`}
            width={width - 6}
            height={3}
            active={!toolFocus && composerPhase}
            ref={composer}
            initialValue={drafts[state.conversation?.id ?? ''] ?? ''}
            onChange={changeComposer}
            onSubmit={submitComposer}
            onArrow={moveInList}
          />
        </Box>
        {list ? (
          <Box height={listRows} flexDirection="column" overflow="hidden">
            {(list.kind === 'file'
              ? list.items.map((path) => `@${path}`)
              : list.items.map(
                  ({ name, argumentHint, description }) =>
                    `/${name}${argumentHint ? ` ${argumentHint}` : ''}  ${description}`,
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
                  {stripAnsi(text).replace(/\s+/g, ' ')}
                </Text>
              ))}
          </Box>
        ) : (
          <Text dimColor>
            {toolFocus
              ? '↑/↓ tools · Enter expand · Tab compose · End live output'
              : 'Enter send · Shift+Enter newline · Ctrl+P commands · PgUp/PgDn scroll'}
          </Text>
        )}
      </Box>
    );
  }
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box height={1} overflow="hidden">
        <Text bold>{header}</Text>
      </Box>
      <Box height={1}>
        <Text dimColor>
          {state.phase}
          {state.native?.permissionMode
            ? ` · ${state.native.permissionMode}`
            : ''}
          {top !== null && view.kind === 'chat'
            ? ' · Reading earlier output'
            : ''}
          {state.phase === 'editing'
            ? ' · Close the VS Code file to finish'
            : ''}
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
      <Box height={1}>
        <Text dimColor>
          Cmd+click links
          {request
            ? ''
            : view.kind !== 'chat'
              ? ' · Esc back'
              : toolFocus
                ? ' · Esc leave tools'
                : list
                  ? ' · Esc close list'
                  : ' · Esc interrupt'}
        </Text>
      </Box>
    </Box>
  );
}
