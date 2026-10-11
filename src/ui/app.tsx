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
      file?: string;
      memory?: boolean;
    };

export function App({
  coordinator,
  onExit,
}: {
  coordinator: Coordinator;
  onExit(): void;
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
  const [selection, setSelection] = useState(0);
  const [pageScroll, setPageScroll] = useState(0);
  const [top, setTop] = useState<ScrollAnchor | null>(null);
  const [toolFocus, setToolFocus] = useState(false);
  const [toolSelection, setToolSelection] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [recovery, setRecovery] = useState('');
  const layout = useRef(new TranscriptLayout()).current;
  const transcript = layout.render(state.items, width - 2, expanded);
  const transcriptHeight = Math.max(2, height - 10 - (state.error ? 1 : 0));
  const maxTop = Math.max(0, transcript.lines.length - transcriptHeight);
  const scrollTop =
    top === null ? maxTop : Math.min(transcript.rowOf(top), maxTop);
  const scrollTo = (row: number | null) =>
    setTop(row === null ? null : (transcript.anchorAt(row) ?? null));
  const tools = state.items.filter((item) => item.kind === 'tool');
  const choices =
    view.kind === 'picker'
      ? view.choices.filter((choice) =>
          `${choice.label} ${choice.id} ${choice.search ?? ''}`
            .toLowerCase()
            .includes(query.toLowerCase()),
        )
      : [];
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
    const files = await coordinator.memoryEntries();
    const entries = await Promise.all(
      files.map(async (file) => ({
        id: file.path,
        label: `${file.path}${file.deleted ? ' (deleted)' : ''}`,
        search: file.deleted ? '' : await coordinator.memory.read(file.path),
        cwd: coordinator.memory.root,
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
            coordinator.memory.read(file).then((text) => {
              setPageScroll(0);
              setView({
                kind: 'page',
                title: file,
                text,
                file: join(coordinator.memory.root, file),
                memory: true,
              });
            }),
          );
      },
    );
  };
  const showHistory = (file: string) => {
    run(
      coordinator.memory.history(file).then((history) =>
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
          { id: '', label: 'Native default' },
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
        picker(
          'Conversations',
          state.conversations.map((conversation) => ({
            id: conversation.id,
            label: `${conversation.title} · ${conversation.agent} · ${basename(conversation.cwd)}`,
            cwd: conversation.cwd,
          })),
          (id) => {
            setView({ kind: 'chat' });
            setTop(null);
            run(coordinator.selectConversation(id));
          },
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
          text: `${commands.map((item) => `/${item.id}  ${item.label}`).join('\n')}\n\nEnter sends. Shift+Enter inserts a newline. Pasted newlines never send.\nCtrl+P opens commands. PageUp/PageDown scroll.\nTab selects tool results; ↑/↓ choose a tool, Enter expands it.\nEnd returns to live output while tools are focused.\nEscape closes a view or interrupts execution.\nCtrl+C interrupts active work or exits while idle.\n\nCmd+click web links to open your browser.\nCmd+click file paths to open VS Code at their line and column.\n\n/model <id> [effort] selects an explicit model.\n/agent <id> switches agents with a handoff.\n\nIn memory: e edits the note in VS Code; h shows its history.\nClose the VS Code file to finish editing and commit its changes.`,
        });
        break;
      case 'quit':
        onExit();
        break;
    }
  };

  useEffect(() => {
    setTop(null);
    setToolSelection(0);
  }, [state.conversation?.id]);
  useEffect(() => {
    if (state.phase === 'recovery') {
      setPageScroll(0);
      run(coordinator.memory.diff().then(setRecovery));
    }
  }, [state.phase, coordinator]);

  useInput((input, key) => {
    if (key.eventType === 'release') return;
    if (key.ctrl && input === 'c') {
      if (busy) run(coordinator.interrupt());
      else onExit();
      return;
    }
    if (request) return;
    if (state.phase === 'recovery') {
      if (key.pageDown || key.downArrow)
        setPageScroll((value) => value + (key.pageDown ? height - 8 : 1));
      if (key.pageUp || key.upArrow)
        setPageScroll((value) =>
          Math.max(0, value - (key.pageUp ? height - 8 : 1)),
        );
      if (input === 'a' || input === 'd')
        run(coordinator.recoverMemory(input === 'a' ? 'accept' : 'discard'));
      return;
    }
    if (key.escape) {
      if (view.kind !== 'chat') setView({ kind: 'chat' });
      else if (busy) run(coordinator.interrupt());
      else setToolFocus(false);
      return;
    }
    if (key.ctrl && input === 'p') {
      picker('Commands', commands, (id) => command(id));
      return;
    }
    if (view.kind === 'picker') {
      if (key.upArrow) setSelection(Math.max(0, selected - 1));
      if (key.downArrow)
        setSelection(Math.min(choices.length - 1, selected + 1));
      return;
    }
    if (view.kind === 'page') {
      if (key.pageDown || key.downArrow)
        setPageScroll((value) => value + (key.pageDown ? height - 5 : 1));
      if (key.pageUp || key.upArrow)
        setPageScroll((value) =>
          Math.max(0, value - (key.pageUp ? height - 5 : 1)),
        );
      if (view.memory && view.file) {
        if (input === 'e') {
          setView({ kind: 'chat' });
          run(coordinator.editMemory(view.file));
        }
        if (input === 'h') {
          showHistory(view.file);
        }
      }
      return;
    }
    if (key.pageUp) scrollTo(Math.max(0, scrollTop - transcriptHeight));
    if (key.pageDown) {
      const next = Math.min(maxTop, scrollTop + transcriptHeight);
      scrollTo(next === maxTop ? null : next);
    }
    if (key.tab) setToolFocus(!toolFocus);
    if (toolFocus) {
      let next = toolSelection;
      if (key.upArrow) next = Math.max(0, toolSelection - 1);
      if (key.downArrow) next = Math.min(tools.length - 1, toolSelection + 1);
      if (next !== toolSelection) {
        setToolSelection(next);
        scrollTo(transcript.starts.get(tools[next]?.id ?? '') ?? null);
      }
      if (key.end) setTop(null);
      if (key.return && tools[toolSelection]) {
        const id = tools[toolSelection]!.id;
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
        height={height - 3}
        cwd={cwd}
        respond={(response) => run(coordinator.respond(request.id, response))}
      />
    );
  else if (state.phase === 'recovery') {
    const lines = wrapAnsi(
      linkify(recovery, coordinator.memory.root),
      width - 2,
      { hard: true, trim: false },
    ).split('\n');
    const top = Math.min(pageScroll, Math.max(0, lines.length - height + 8));
    body = (
      <Box flexDirection="column" height={height - 3}>
        <Text color="yellow" bold>
          Unfinished memory changes
        </Text>
        <Text>
          Accept these changes with their original attribution, or discard them.
        </Text>
        <Box height={Math.max(1, height - 8)} overflow="hidden">
          <Text>
            {lines.slice(top, top + Math.max(1, height - 8)).join('\n')}
          </Text>
        </Box>
        <Text bold>a accept · d discard · ↑/↓ scroll · Ctrl+C quit</Text>
      </Box>
    );
  } else if (view.kind === 'picker') {
    const count = Math.max(1, height - 9);
    const first = Math.max(0, selected - count + 1);
    body = (
      <Box flexDirection="column" height={height - 3}>
        <Text bold>{view.title}</Text>
        <Box height={height - 7} flexDirection="column" overflow="hidden">
          {choices.slice(first, first + count).map((choice, index) => (
            <Text key={choice.id} inverse={first + index === selected}>
              {linkify(` ${choice.label} `, choice.cwd ?? cwd)}
            </Text>
          ))}
        </Box>
        <Input
          key={view.title}
          width={width - 2}
          height={1}
          cwd={cwd}
          active
          multiline={false}
          placeholder="Filter, then Enter"
          onChange={(text) => {
            setQuery(text);
            setSelection(0);
          }}
          onSubmit={(text) => {
            const choice = choices[selected];
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
    const top = Math.min(pageScroll, Math.max(0, lines.length - height + 6));
    body = (
      <Box flexDirection="column" height={height - 3}>
        <Text bold>
          {view.file ? hyperlink(view.title, view.file, cwd) : view.title}
        </Text>
        <Box height={height - 6} overflow="hidden">
          <Text>{lines.slice(top, top + height - 6).join('\n')}</Text>
        </Box>
        <Text dimColor>
          {view.memory ? 'e edit · h history · ' : ''}↑/↓ scroll · Esc back
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
      <Box flexDirection="column" height={height - 3}>
        <Box height={transcriptHeight} overflow="hidden">
          <Text>
            {state.items.length
              ? visible.join('\n')
              : colors.dim(
                  'Start a conversation. Use /agent to choose Codex or Claude Code.\nShared memory carries verified preferences between conversations.\nCtrl+P opens commands; /help lists keyboard controls.',
                )}
          </Text>
        </Box>
        {state.error && (
          <Box height={1} overflow="hidden">
            <Text color="red">{linkify(state.error, cwd)}</Text>
          </Box>
        )}
        <Box
          borderStyle="round"
          borderColor={toolFocus ? 'gray' : 'cyan'}
          height={5}
          paddingX={1}
        >
          <Input
            key={state.conversation?.id ?? 'initial'}
            width={width - 6}
            height={3}
            cwd={cwd}
            active={
              !toolFocus &&
              !['starting', 'closing', 'error'].includes(state.phase)
            }
            initialValue={drafts[state.conversation?.id ?? ''] ?? ''}
            onChange={(value) =>
              setDrafts((previous) => ({
                ...previous,
                [state.conversation?.id ?? '']: value,
              }))
            }
            onSubmit={(text) => {
              const match =
                /^\/(new|sessions|agent|model|memory|help|quit)(?:\s+(.*))?$/.exec(
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
              run(coordinator.send(text));
              return true;
            }}
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
      <Box height={1}>
        <Text dimColor>
          Cmd+click links · Esc {view.kind === 'chat' ? 'interrupt' : 'back'}
        </Text>
      </Box>
    </Box>
  );
}
