import { useEffect, useMemo, useState } from 'react';
import { Box, Text, flushSync } from 'ink';
import type { Key } from 'ink';
import { dirname, join } from 'node:path';
import type { Coordinator } from '../../core/coordinator.js';
import type { JobWatch } from '../../core/jobs/jobs.js';
import { modelKey } from '../../core/runtime/models.js';
import type {
  RuntimeUpdates,
  RuntimeUpdateSnapshot,
} from '../../core/runtime/runtime-updates.js';
import { agentLabel, type Snapshot } from '../../core/snapshot.js';
import type { CoordinationSnapshot } from '../../core/coordination/coordination-state.js';
import { errorMessage } from '../../errors.js';
import { CommandBatches } from './command-batches.js';
import { commands } from './commands.js';
import type { WitchCommand, CommandName } from './commands.js';
import type { View } from './choices.js';
import { conversationLabel } from './conversations.js';
import { delegation } from './delegation.js';
import { elapsed } from '../status/elapsed.js';
import { helpText } from './help.js';
import { Input } from '../input/Input.js';
import { hyperlink, linkify, oneLine, plain } from '../links.js';
import { useLiveState } from '../useLiveState.js';
import { markdown } from '../transcript/markdown.js';
import { chooseModel } from './model-choice.js';
import { coordinationText } from './peers.js';
import { ScrollPage } from '../ScrollPage.js';
import { pageStart } from '../scroll-page-layout.js';
import type { PagePosition } from '../scroll-page-layout.js';
import { piped } from '../theme.js';
import { showUpdates, updatesText } from './updates.js';
import { usePicker } from './usePicker.js';
import { wrapSourceLines } from '../wrap.js';

export function useCommandViews({
  coordinator,
  cwd,
  jobs,
  policy,
  updates,
  onExit,
  onRestart,
  toEnd,
}: {
  coordinator: Coordinator;
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

  const {
    picker,
    dismissPicker,
    choose,
    changeQuery,
    choices,
    selected,
    pickerInput,
    chosenInRead,
    moveSelection,
    close,
  } = usePicker({
    view,
    viewRef,
    setView,
    report: (error) => coordinator.report(error),
  });

  useEffect(
    () => () => {
      close();
      batches.close();
    },
    [batches],
  );

  const [pageScroll, setPageScroll] = useState<PagePosition>(pageStart);

  const openPage = (next: View) => {
    setPageScroll(pageStart);
    setView(next);
  };

  const [leaving, leavingRef, setLeaving] = useLiveState<string | undefined>(
    undefined,
  );

  /** a task refusal stays transient, but stops the command batch that requested it. */
  const changeTask = async (operation: Promise<void>): Promise<boolean> => {
    try {
      await operation;

      if (viewRef.current.kind === 'chat')
        openPage({ kind: 'coordination', mode: 'task' });

      return true;
    } catch (error) {
      coordinator.notice(errorMessage(error), { save: false });

      return false;
    }
  };

  /** a switch shows the old conversation until the next opens, so its draft cannot go to the new one. */
  const leave = async (operation: () => Promise<void>) => {
    if (coordinator.snapshot.phase !== 'idle') return operation();

    setLeaving(coordinator.snapshot.conversation?.id);

    return operation().finally(() => setLeaving(undefined));
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
        if (file === '+') return coordinator.editMemory();

        if (notes.find((note) => note.path === file)?.deleted)
          return showHistory(file, active);

        openPage({
          kind: 'page',
          title: file,
          text: noteChoices.find((choice) => choice.id === file)!.search,
          link: memory.root && join(memory.root, file),
          note: file,
        });
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
            { save: false },
          );

          return false;
        }

        openPage({ kind: 'coordination', mode: 'task' });

        break;

      case 'model':
        if (argument) {
          const [id, effort] = argument.split(/\s+/);
          await selectModel(id!, effort);

          break;
        }

        if (!(await coordinator.refreshModels()) || !active()) return false;

        return picker(
          'Models · type an ID or choose one',
          coordinator.snapshot.models.map((model) => ({
            id: modelKey(model),
            label: `${agentLabel(coordinator.snapshot.agents, model.agent)} · ${model.label}`,
            exact: model.id,
          })),
          (id) => selectModel(id, undefined, active),
          { custom: true },
        );

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
        return showUpdates(argument, {
          updates,
          agents: coordinator.snapshot.agents,
          active,
          picker,
          details: () => {
            openPage({ kind: 'updates' });

            return true;
          },
          notice: (text) => coordinator.notice(text, { cwd, save: false }),
        });

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

      default:
        return name satisfies never;
    }

    return true;
  };

  const command = (name: CommandName) =>
    batches.submit([{ name, argument: '' }], executeCommand);

  const handleKey = (input: string, key: Key): boolean => {
    const modified = key.ctrl || key.meta || key.super;

    if (view.kind === 'picker') {
      moveSelection(key);

      return true;
    }

    if (view.kind !== 'chat') {
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
    chosenInRead,
    choices,
    selected,
    changeQuery,
    choose,
    dismissPicker,
    handleKey,
    /** renders the picker before the rest of Ctrl+P's read, so the keys after it reach the picker. */
    showCommands: () =>
      flushSync(() =>
        picker('Commands', commands, (id) => command(id as CommandName)),
      ),
    submit: (commands: readonly WitchCommand[]) =>
      batches.submit(commands, executeCommand),
  };
}

function pageContent(
  view: View,
  cwd: string,
  coordination: CoordinationSnapshot | undefined,
  updates: RuntimeUpdateSnapshot,
  agents: Snapshot['agents'],
): { title: string; text: string } | undefined {
  switch (view.kind) {
    case 'page':
      return {
        // a note's file name can hold a line break, and Ink keeps OSC 8 links
        title: oneLine(view.title),
        text: view.styled
          ? view.text
          : markdown(
              view.text,
              cwd,
              view.note === undefined
                ? cwd
                : view.link
                  ? dirname(view.link)
                  : null,
            ),
      };

    case 'coordination':
      return {
        title: view.mode === 'peers' ? 'Repository sessions' : 'Current task',
        text: coordinationText(coordination, view.mode),
      };

    case 'updates':
      return {
        title: 'Native runtime updates',
        text: updatesText(updates, agents),
      };

    case 'chat':

    case 'picker':
      return;
  }
}

export function CommandView({
  views,
  width: bodyWidth,
  height: bodyHeight,
  cwd,
  coordination,
  updates,
  agents,
  copy,
  current,
}: {
  views: ReturnType<typeof useCommandViews>;
  width: number;
  height: number;
  cwd: string;
  coordination: CoordinationSnapshot | undefined;
  updates: RuntimeUpdateSnapshot;
  agents: Snapshot['agents'];
  copy?(text: string): void;

  current?(): boolean;
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

  const { title, lines: pageLines } = useMemo(() => {
    const content = pageContent(view, cwd, pageCoordination, updates, agents);

    return {
      title: content?.title ?? '',
      lines: wrapSourceLines(content?.text ?? '', bodyWidth),
    };
  }, [view, cwd, pageCoordination, updates, agents, bodyWidth]);

  const pageHeading = Number(bodyHeight >= 3);
  const pageHint = Number(bodyHeight >= 2);

  const pageRows =
    bodyHeight - pageHeading - pageHint - Number(bodyHeight >= 4);

  const page = (
    <ScrollPage
      width={bodyWidth}
      identity={view}
      copy={copy}
      current={() => (current?.() ?? true) && views.viewRef.current === view}
      lines={pageLines}
      height={pageRows}
      scroll={pageScroll}
      setScroll={setPageScroll}
      arrows
    />
  );

  if (view.kind === 'picker') {
    const heading = Number(bodyHeight >= 4);
    // from 6 rows, the first height where the caption still leaves a choice row
    const caption = Number(!!view.caption && bodyHeight >= 6);
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
  } else if (view.kind !== 'chat') {
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
