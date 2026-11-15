import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import type { Key } from 'ink';
import { dirname, join } from 'node:path';
import type { Coordinator } from '../../core/coordinator.js';
import type { JobWatch } from '../../core/jobs/jobs.js';
import { modelKey } from '../../core/runtime/models.js';
import type {
  RuntimeUpdates,
  RuntimeUpdateSnapshot,
} from '../../core/runtime/runtime-updates.js';
import type { Snapshot } from '../../core/snapshot.js';
import type { CoordinationSnapshot } from '../../core/coordination/coordination-state.js';
import { errorMessage } from '../../errors.js';
import { CommandBatches } from './command-batches.js';
import { commands } from './commands.js';
import type { WitchCommand, CommandName } from './commands.js';
import type { Choice, Picker, View } from './choices.js';
import { conversationLabel } from './conversations.js';
import { delegation } from './delegation.js';
import { elapsed } from '../status/elapsed.js';
import { helpText } from './help.js';
import { Input } from '../input/Input.js';
import type { InputHandle } from '../input/Input.js';
import { hyperlink, linkify, oneLine, plain } from '../links.js';
import { useLiveState } from '../live-state.js';
import { markdown } from '../transcript/markdown.js';
import { chooseModel } from './model-choice.js';
import { coordinationText } from './peers.js';
import { ScrollPage } from '../ScrollPage.js';
import { pageStart } from '../scroll-page-layout.js';
import type { PagePosition } from '../scroll-page-layout.js';
import { piped } from '../theme.js';
import { showUpdates, updatesText } from './updates.js';
import { wrapSourceLines } from '../wrap.js';

export function useCommandViews({
  coordinator,
  state,
  cwd,
  jobs,
  policy,
  updates,
  onExit,
  onRestart,
  toEnd,
}: {
  coordinator: Coordinator;
  state: Snapshot;
  cwd: string;
  jobs?: Pick<JobWatch, 'list' | 'stop'>;
  policy?: Parameters<typeof delegation>[1];
  updates?: RuntimeUpdates;
  onExit(): void;

  onRestart?(): void;

  toEnd(): void;
}) {
  const [view, viewRef, setView] = useLiveState<View>({ kind: 'chat' });
  const [batches] = useState(() => new CommandBatches(coordinator));
  const disposed = useRef(false);

  const pickerWait = useRef<PromiseWithResolvers<boolean> | undefined>(
    undefined,
  );

  useEffect(
    () => () => {
      disposed.current = true;
      batches.close();
      pickerWait.current?.resolve(false);
      pickerWait.current = undefined;
    },
    [batches],
  );

  const [query, setQuery] = useState('');
  const [selection, selectionRef, setSelection] = useLiveState(0);
  const [pageScroll, setPageScroll] = useState<PagePosition>(pageStart);

  const openPage = (next: View) => {
    setPageScroll(pageStart);
    setView(next);
  };

  const [leaving, leavingRef, setLeaving] = useLiveState<string | undefined>(
    undefined,
  );

  const pickerInput = useRef<InputHandle>(null);

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

  /** a task refusal stays transient, but stops the command batch that requested it. */
  const changeTask = async (operation: Promise<void>): Promise<boolean> => {
    try {
      await operation;

      if (viewRef.current.kind === 'chat') {
        openPage({ kind: 'coordination', mode: 'task' });
      }

      return true;
    } catch (error) {
      coordinator.notice(errorMessage(error), undefined, false);

      return false;
    }
  };

  /** a switch shows the old conversation until the next opens, so its draft cannot go to the new one. */
  const leave = async (operation: () => Promise<void>) => {
    if (coordinator.snapshot.phase !== 'idle') return operation();

    setLeaving(coordinator.snapshot.conversation?.id);

    return operation().finally(() => setLeaving(undefined));
  };

  const dismissPicker = (success = true) => {
    const waiting = pickerWait.current;
    pickerWait.current = undefined;
    waiting?.resolve(success);
    setView({ kind: 'chat' });
  };

  const picker: Picker = (title, entries, choose, custom = false, caption) => {
    if (disposed.current) return Promise.resolve(false);

    pickerWait.current?.resolve(true);
    const waiting = Promise.withResolvers<boolean>();
    pickerWait.current = waiting;
    pickerInput.current?.set({ value: '', cursor: 0 });
    setQuery('');
    setSelection(0);

    setView({
      kind: 'picker',
      title,
      caption,
      choices: [...entries],
      custom,
      choose: (id) => {
        if (pickerWait.current !== waiting) return;

        // a nested picker owns the visible wait while this action still awaits its result
        pickerWait.current = undefined;
        setView({ kind: 'chat' });

        void (async () => {
          try {
            waiting.resolve((await choose(id)) !== false);
          } catch (error) {
            coordinator.report(error);
            waiting.resolve(false);
          }
        })();
      },
    });

    return waiting.promise;
  };

  const showMemory = async (active: () => boolean) => {
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

    if (!active()) return false;

    return picker(
      'Shared memory',
      [{ id: '+', label: 'Edit project essentials' }, ...noteChoices],
      (file) => {
        if (file === '+') {
          return coordinator.editMemory();
        } else if (notes.find((note) => note.path === file)?.deleted) {
          return showHistory(file, active);
        } else {
          openPage({
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

  const showHistory = async (file: string, active = () => true) => {
    const memory = await coordinator.memoryView();
    const history = await coordinator.memory.history(memory.revision, file);

    if (!active()) return false;

    return picker(
      'Restore a memory version',
      history.map((item) => ({
        id: item.revision,
        label: `${item.revision.slice(0, 8)} ${item.subject}`,
      })),
      (revision) => coordinator.restoreMemory(file, revision),
    );
  };

  const showJobs = async (active: () => boolean) => {
    const found = (await jobs?.list()) ?? [];

    if (!active()) return false;

    return picker(
      found.length ? 'Jobs · choose one to stop' : 'No jobs are running',
      found.map((job) => ({
        id: String(job.group),
        label: `${Math.round(job.cpu)}% CPU · ${elapsed(Date.now() - job.startedAt)} · ${job.command}`,
      })),
      (id) => jobs!.stop(found.find(({ group }) => String(group) === id)!),
    );
  };

  const selectModel = (id: string, effort?: string, live?: () => boolean) =>
    chooseModel(
      {
        coordinator,
        picker,
        toChat: (handoff) => {
          setView({ kind: 'chat' });

          if (handoff) toEnd();
        },
      },
      id,
      effort,
      live,
    );

  const executeCommand = async (
    { name, argument }: WitchCommand,
    active: () => boolean,
  ): Promise<boolean> => {
    switch (name) {
      case 'new':
        await leave(() => coordinator.newConversation(argument || undefined));

        break;

      case 'sessions': {
        const conversations = await coordinator.conversations();

        if (!active()) return false;

        return picker(
          'Conversations',
          conversations.map((conversation) => ({
            id: conversation.id,
            label: conversationLabel(conversation),
            cwd: conversation.cwd,
          })),
          (id) => {
            toEnd();

            return leave(() => coordinator.selectConversation(id));
          },
        );
      }

      case 'peers':
        openPage({ kind: 'coordination', mode: 'peers' });

        break;

      case 'task':
        if (argument === 'release')
          return changeTask(coordinator.releaseTask());

        if (/^take\s+\S/.test(argument))
          return changeTask(coordinator.takeTask(argument.slice(4).trim()));

        if (argument) {
          coordinator.notice(
            'Use /task, /task release or /task take <reference>.',
            undefined,
            false,
          );

          return false;
        }

        openPage({ kind: 'coordination', mode: 'task' });

        break;

      case 'model':
        if (argument) {
          const [id, effort] = argument.split(/\s+/);
          await selectModel(id!, effort);
        } else {
          if (!(await coordinator.refreshModels()) || !active()) return false;

          return picker(
            'Models · type an ID or choose one',
            coordinator.snapshot.models.map((model) => ({
              id: modelKey(model),
              label: `${state.agents.find((agent) => agent.id === model.agent)!.label} · ${model.label}`,
              exact: model.id,
            })),
            (id) => selectModel(id, undefined, active),
            true,
          );
        }

        break;

      case 'delegation': {
        const text = await delegation(argument, policy, coordinator);

        if (!text) return false;

        openPage({ kind: 'page', title: 'Delegation', text });

        break;
      }

      case 'review':
        return coordinator.review(argument);

      case 'compact':
        return coordinator.compact();

      case 'clear':
        await coordinator.clear();

        break;

      case 'memory':
        return showMemory(active);

      case 'jobs':
        return showJobs(active);

      case 'updates':
        return showUpdates(
          argument,
          updates,
          state.agents,
          active,
          picker,
          () => {
            openPage({ kind: 'updates' });

            return true;
          },
          (text) => coordinator.notice(text, cwd, false),
        );

      case 'help':
        openPage({
          kind: 'page',
          title: 'Keyboard help',
          text: helpText(),
          styled: true,
        });

        break;

      case 'restart':
        batches.cancel(false);
        onRestart?.();

        break;

      case 'exit':
        batches.cancel(false);
        onExit();

        break;
    }

    return true;
  };

  const command = (name: CommandName) =>
    batches.submit([{ name, argument: '' }], executeCommand);

  const choose = (text: string): boolean => {
    // the filter and selection a read changed are not rendered yet
    const current = viewRef.current;

    if (current.kind !== 'picker') return false;

    const matching = filter(current.choices, text);

    const choice =
      matching[Math.min(selectionRef.current, matching.length - 1)];

    if (choice) current.choose(choice.id);
    else if (current.custom && text.trim()) current.choose(text.trim());
    else return false;

    return true;
  };

  const changeQuery = (text: string) => {
    setQuery(text);
    setSelection(0);
  };

  const handleKey = (input: string, key: Key): boolean => {
    const modified = key.ctrl || key.meta || key.super;

    if (view.kind === 'picker') {
      const current = Math.min(
        selectionRef.current,
        Math.max(0, choices.length - 1),
      );

      if (key.upArrow) setSelection(Math.max(0, current - 1));

      if (key.downArrow)
        setSelection(Math.max(0, Math.min(choices.length - 1, current + 1)));

      return true;
    }

    if (
      view.kind === 'page' ||
      view.kind === 'coordination' ||
      view.kind === 'updates'
    ) {
      if (view.kind === 'page' && view.note && !modified) {
        if (input === 'e') {
          setView({ kind: 'chat' });

          void coordinator
            .editMemory(view.note)
            .catch((error: unknown) => coordinator.report(error));
        }

        if (input === 'h') {
          void showHistory(view.note).catch((error: unknown) =>
            coordinator.report(error),
          );
        }
      }

      return true;
    }

    return false;
  };

  return {
    view,
    viewRef,
    leaving,
    leavingRef,
    batches,
    pageScroll,
    setPageScroll,
    pickerInput,
    choices,
    selected,
    changeQuery,
    choose,
    dismissPicker,
    handleKey,
    showCommands: () =>
      picker('Commands', commands, (id) => command(id as CommandName)),
    submit: (commands: readonly WitchCommand[]) =>
      batches.submit(commands, executeCommand),
  };
}

export function CommandView({
  views,
  width: bodyWidth,
  height: bodyHeight,
  cwd,
  coordination,
  updates,
  agents,
}: {
  views: ReturnType<typeof useCommandViews>;
  width: number;
  height: number;
  cwd: string;
  coordination: CoordinationSnapshot | undefined;
  updates: RuntimeUpdateSnapshot;
  agents: Snapshot['agents'];
}) {
  const {
    view,
    choices,
    selected,
    pageScroll,
    setPageScroll,
    pickerInput,
    changeQuery,
    choose,
  } = views;

  const pageCoordination =
    view.kind === 'coordination' ? coordination : undefined;

  const pageLines = useMemo(() => {
    const pageText =
      view.kind === 'page' && view.styled
        ? view.text
        : view.kind === 'page'
          ? markdown(
              view.text,
              cwd,
              view.note === undefined
                ? cwd
                : view.link
                  ? dirname(view.link)
                  : null,
            )
          : view.kind === 'coordination'
            ? coordinationText(pageCoordination, view.mode)
            : view.kind === 'updates'
              ? updatesText(updates, agents)
              : '';

    return wrapSourceLines(pageText, bodyWidth);
  }, [view, cwd, pageCoordination, updates, agents, bodyWidth]);

  const pageHeading = Number(bodyHeight >= 3);
  const pageHint = Number(bodyHeight >= 2);

  const pageRows =
    bodyHeight - pageHeading - pageHint - Number(bodyHeight >= 4);

  const page = (
    <ScrollPage
      lines={pageLines}
      height={pageRows}
      scroll={pageScroll}
      setScroll={setPageScroll}
      arrows
    />
  );

  if (view.kind === 'picker') {
    const heading = Number(bodyHeight >= 4);
    const caption = Number(!!view.caption && bodyHeight >= 5);
    const hint = Number(bodyHeight >= 3);

    const count = Math.max(
      0,
      bodyHeight - 1 - heading - caption - hint - Number(bodyHeight >= 5),
    );

    const first = Math.max(0, selected - count + 1);

    return (
      <Box flexDirection="column" height={bodyHeight}>
        <Box height={heading} flexShrink={0} overflow="hidden">
          <Text bold wrap="truncate-end">
            {plain(view.title)}
          </Text>
        </Box>
        {caption > 0 && (
          <Text wrap="truncate-middle">{plain(view.caption ?? '')}</Text>
        )}
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
          onChange={changeQuery}
          onSubmit={choose}
        />
        <Box height={hint} flexShrink={0} overflow="hidden">
          <Text dimColor wrap="truncate-end">
            {piped(['↑/↓ CHOOSE', 'ENTER SELECT', 'ESC BACK'])}
          </Text>
        </Box>
      </Box>
    );
  } else if (
    view.kind === 'page' ||
    view.kind === 'coordination' ||
    view.kind === 'updates'
  ) {
    // a note's file name is agent-written and can hold a line break, and Ink keeps OSC 8 links
    const title =
      view.kind === 'page'
        ? oneLine(view.title)
        : view.kind === 'updates'
          ? 'Native runtime updates'
          : view.mode === 'peers'
            ? 'Repository sessions'
            : 'Current task';

    return (
      <Box flexDirection="column" height={bodyHeight}>
        {pageHeading > 0 && (
          <Text bold wrap="truncate-end">
            {view.kind === 'page' && view.link
              ? hyperlink(title, view.link, cwd)
              : title}
          </Text>
        )}
        {page}
        {pageHint > 0 && (
          <Text dimColor wrap="truncate-end">
            {piped([
              ...(view.kind === 'page' && view.note
                ? ['e EDIT', 'h HISTORY']
                : []),
              '↑/↓ SCROLL',
              'ESC BACK',
            ])}
          </Text>
        )}
      </Box>
    );
  }

  return null;
}
