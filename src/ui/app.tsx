import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import { basename, join } from 'node:path';
import wrapAnsi from 'wrap-ansi';
import type { Coordinator } from '../core/coordinator.js';
import { Input } from './input.js';
import { Request } from './request.js';
import { TranscriptLayout } from './transcript-layout.js';
import type { ScrollAnchor } from './transcript-layout.js';
import { colors, markdown } from './markdown.js';
import { hyperlink, linkify } from './links.js';
import { useLiveState } from './live-state.js';

const commands = [
  { id: 'new', label: 'New conversation' },
  { id: 'sessions', label: 'Saved conversations' },
  { id: 'agent', label: 'Switch agent' },
  { id: 'model', label: 'Choose model and reasoning' },
  { id: 'memory', label: 'Browse shared memory' },
  { id: 'help', label: 'Keyboard help' },
  { id: 'quit', label: 'Quit' },
];

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
  const transcriptHeight = Math.max(2, bodyHeight - 7);
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
  const filter = (entries: Choice[], text: string) =>
    entries.filter((choice) =>
      `${choice.label} ${choice.id} ${choice.search ?? ''}`
        .toLowerCase()
        .includes(text.toLowerCase()),
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
    const files = await coordinator.memory.catalog(
      memory.revision,
      memory.scope,
    );
    const entries = await Promise.all(
      files.map(async (file) => ({
        id: file.path,
        label: `${file.path}${file.deleted ? ' (deleted)' : ''}`,
        search: file.deleted
          ? ''
          : await coordinator.memory.read(memory.revision, file.path),
        cwd: memory.root,
      })),
    );
    picker(
      'Shared memory',
      [{ id: '+', label: 'Edit project essentials' }, ...entries],
      (file) => {
        if (file === '+') {
          setView({ kind: 'chat' });
          run(coordinator.editMemory());
        } else if (files.find((entry) => entry.path === file)?.deleted) {
          showHistory(file);
        } else
          run(
            coordinator.memory.read(memory.revision, file).then((text) => {
              setPageScroll(0);
              setView({
                kind: 'page',
                title: file,
                text,
                link: memory.root && join(memory.root, file),
                note: file,
              });
            }),
          );
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
        if (argument) run(coordinator.switchAgent(argument));
        else
          picker(
            'Installed agents',
            state.agents.map((agent) => ({
              id: agent.id,
              label: `${agent.label}${agent.installed ? '' : ' (not installed)'}`,
            })),
            (id) => {
              setView({ kind: 'chat' });
              setTop(null);
              run(coordinator.switchAgent(id));
            },
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
          text: `${commands.map((item) => `/${item.id}  ${item.label}`).join('\n')}\n\nEnter sends. Shift+Enter inserts a newline. Pasted newlines never send.\nCtrl+P opens commands. PageUp/PageDown scroll.\nTab selects tool results; ↑/↓ choose a tool, Enter expands it.\nEnd returns to live output while tools are focused.\nEscape closes a view, then leaves tool focus, then interrupts execution.\nOn a request, Escape declines it and the turn continues.\nCtrl+C interrupts active work or exits while idle, and quits at once while closing.\n\nCmd+click web links to open your browser.\nCmd+click file paths to open VS Code at their line and column.\n\n/model <id> [effort] selects an explicit model.\n/agent <id> switches agents with a handoff.\n/exit also quits.\n\nIn memory: e edits the note in VS Code; h shows its history.\nClose the VS Code file to finish editing and commit its changes.`,
        });
        break;
      case 'quit':
      case 'exit':
        onExit();
        break;
    }
  };

  const submit = (text: string): boolean => {
    // Enter while tools are focused expands a tool, even in the same read as Tab
    if (toolFocusRef.current) return false;
    const match =
      /^\/(new|sessions|agent|model|memory|help|quit|exit)(?:\s+(.*))?$/.exec(
        text.trim(),
      );
    if (match) {
      command(match[1]!, match[2]);
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
      if (key.pageDown || key.downArrow)
        setPageScroll((value) => value + (key.pageDown ? bodyHeight - 5 : 1));
      if (key.pageUp || key.upArrow)
        setPageScroll((value) =>
          Math.max(0, value - (key.pageUp ? bodyHeight - 5 : 1)),
        );
      const kind = state.recovery?.kind;
      if (input === 'd') run(coordinator.recoverMemory('discard'));
      if (input === 'a' && kind === 'pending')
        run(coordinator.recoverMemory('accept'));
      if (input === 'k' && kind === 'conflict')
        run(coordinator.recoverMemory('keep'));
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
      if (key.pageDown || key.downArrow)
        setPageScroll((value) => value + (key.pageDown ? bodyHeight - 2 : 1));
      if (key.pageUp || key.upArrow)
        setPageScroll((value) =>
          Math.max(0, value - (key.pageUp ? bodyHeight - 2 : 1)),
        );
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
      if (key.downArrow) next = Math.min(tools.length - 1, current + 1);
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
    const recovery = state.recovery;
    const conflict = recovery?.kind === 'conflict';
    const text = conflict
      ? `${recovery.paths.length ? `Conflicting paths:\n${recovery.paths.join('\n')}` : 'This conflict has no single path.'}\n\nYour changes:\n${recovery.diff}`
      : (recovery?.diff ?? '');
    const lines = wrapAnsi(linkify(text, recovery?.root ?? cwd), width - 2, {
      hard: true,
      trim: false,
    }).split('\n');
    const visible = Math.max(1, bodyHeight - 5);
    const top = Math.min(pageScroll, Math.max(0, lines.length - visible));
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
        <Box height={visible} overflow="hidden">
          <Text>{lines.slice(top, top + visible).join('\n')}</Text>
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
    const count = Math.max(1, bodyHeight - 6);
    const first = Math.max(0, selected - count + 1);
    body = (
      <Box flexDirection="column" height={bodyHeight}>
        <Text bold>{view.title}</Text>
        <Box height={bodyHeight - 4} flexDirection="column" overflow="hidden">
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
    const lines = wrapAnsi(markdown(view.text, cwd), width - 2, {
      hard: true,
      trim: false,
    }).split('\n');
    const visible = Math.max(1, bodyHeight - 3);
    const top = Math.min(pageScroll, Math.max(0, lines.length - visible));
    body = (
      <Box flexDirection="column" height={bodyHeight}>
        <Text bold>
          {view.link ? hyperlink(view.title, view.link, cwd) : view.title}
        </Text>
        <Box height={visible} overflow="hidden">
          <Text>{lines.slice(top, top + visible).join('\n')}</Text>
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
            active={
              !toolFocus &&
              !['starting', 'closing', 'error'].includes(state.phase)
            }
            initialValue={drafts[state.conversation?.id ?? ''] ?? ''}
            onChange={(value) => setDraft(state.conversation?.id ?? '', value)}
            onSubmit={submit}
          />
        </Box>
        <Text dimColor>
          {toolFocus
            ? '↑/↓ tools · Enter expand · Tab compose · End live output'
            : 'Enter send · Shift+Enter newline · Ctrl+P commands · PgUp/PgDn scroll'}
        </Text>
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
                : ' · Esc interrupt'}
        </Text>
      </Box>
    </Box>
  );
}
