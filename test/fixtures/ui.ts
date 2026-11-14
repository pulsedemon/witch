import { EventEmitter } from 'node:events';

import { setTimeout as delay } from 'node:timers/promises';

import { Box, render } from 'ink';

import { createElement, useSyncExternalStore } from 'react';

import type { ReactElement } from 'react';

import stripAnsi from 'strip-ansi';

import type { Coordinator } from '../../src/core/coordinator.js';

import type { Snapshot } from '../../src/core/snapshot.js';

import { PentacleActivity } from '../../src/core/pentacle-activity.js';

import { MouseInput } from '../../src/ui/mouse.js';

import { Sidebar } from '../../src/ui/sidebar.js';

import { until } from './within.js';

/** not a TTY, so every write is a whole frame. */
class Terminal extends EventEmitter {
  readonly frames: string[] = [];
  constructor(
    public columns: number,
    public rows: number,
  ) {
    super();
  }
  resize(columns: number, rows = this.rows) {
    this.columns = columns;

    this.rows = rows;

    this.emit('resize');
  }
  write = (frame: string) => {
    this.frames.push(frame);

    return true;
  };
}

class Keys extends EventEmitter {
  readonly isTTY = true;
  private data: string | null = null;
  write(data: string) {
    this.data = data;

    this.emit('readable');

    this.emit('data', data);
  }
  read = () => {
    const data = this.data;

    this.data = null;

    return data;
  };
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
}

export function show(element: ReactElement, columns = 100, rows = 40) {
  const stdout = new Terminal(columns, rows);

  const stdin = new Keys();

  const instance = render(element, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    // as the CLI reads input, so keys and mouse reports share one stream
    stdin: new MouseInput(stdin) as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  return {
    stdin,
    frame: () => stdout.frames.at(-1) ?? '',
    text: () => stripAnsi(stdout.frames.at(-1) ?? ''),
    resize: (columns: number, rows?: number) => stdout.resize(columns, rows),
    unmount: () => instance.unmount(),
  };
}

/** sidebar overflow is independent of App's minimum terminal size. */
export function SidebarView({
  coordinator,
  height,
}: {
  coordinator: Coordinator;
  height: number;
}) {
  const state = useSyncExternalStore(
    coordinator.subscribe,
    () => coordinator.snapshot,
  );

  const coordination = useSyncExternalStore(
    coordinator.coordination?.subscribe ?? (() => () => {}),
    () => coordinator.coordination?.snapshot,
  );

  return createElement(
    Box,
    { width: 115, height },
    createElement(Box, { width: 80 }),
    createElement(Sidebar, {
      height,
      activity: coordinator.pentacle,
      brews: state.backgroundCommands,
      subagents: state.subagents,
      peers: coordination?.peers,
    }),
  );
}

/** a link sequence whole, which strip-ansi removes, then split by codes whose removal joins it back up */
export function forgedLink(target: string, text: string) {
  return (
    `\u001b]8;;${target}\u0007${text}\u001b]8;;\u0007` +
    `\u001b\u001b[31m]8;;${target}\u0007${text}\u001b\u001b[0m]8;;\u0007`
  );
}

/** a coordinator stand-in that publishes snapshots and records the calls the app makes. */
export function fake(snapshot: Partial<Snapshot>, files: string[] = []) {
  const listeners = new Set<() => void>();

  const calls: unknown[][] = [];

  // the composer saves its text on every change, so these stay out of `calls`
  const drafts: [string, string][] = [];

  let holds = 0;

  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
    };

  const coordinator = {
    pentacle: new PentacleActivity(),
    snapshot: {
      phase: 'idle',
      items: [],
      queue: [],
      commandsPending: false,
      pendingCompaction: false,
      requests: [],
      models: [],
      skills: [],
      subagents: [],
      backgroundCommands: [],
      usage: {},
      accounts: {},
      latest: {},
      agents: ['a', 'b'].map((id) => ({ id, label: id, installed: true })),
      conversation: {
        id: 'c',
        title: 't',
        cwd: '/work',
        agent: 'a',
        sessions: {},
        createdAt: '',
      },
      ...snapshot,
    } as Snapshot,
    memory: { root: '/state/memory.git' },
    subscribe(listener: () => void) {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    publish(update: Partial<Snapshot>) {
      coordinator.snapshot = { ...coordinator.snapshot, ...update };

      for (const listener of listeners) listener();
    },
    send: record('send'),
    // synchronous, as the composer inserts its result in the same paste
    paste: (text: string, before: string): string | undefined => {
      calls.push(['paste', text, before]);

      return undefined;
    },
    compact: async () => {
      calls.push(['compact']);

      return true;
    },
    holdPromptDelivery: () => {
      holds++;

      coordinator.publish({ commandsPending: true });

      let released = false;

      return () => {
        if (released) return;

        released = true;

        coordinator.publish({ commandsPending: --holds > 0 });
      };
    },
    clear: record('clear'),
    draft: (id: string, text: string) => drafts.push([id, text]),
    unqueue: (draft: string) => {
      calls.push(['unqueue', draft]);

      const { queue } = coordinator.snapshot;

      coordinator.publish({ queue: [] });

      return [...queue];
    },
    interrupt: record('interrupt'),
    respond: record('respond'),
    recoverMemory: record('recoverMemory'),
    newConversation: record('newConversation'),
    selectConversation: record('selectConversation'),
    refreshModels: async () => {
      calls.push(['refreshModels']);

      return true;
    },
    selectModel: record('selectModel'),
    report: (error: unknown) => calls.push(['report', String(error)]),
    notice: record('notice'),
    conversations: async () => [
      {
        id: 'c2',
        title: 'Other',
        agent: 'a',
        cwd: '/work',
        modified: new Date(2026, 10, 3, 23, 46).getTime(),
      },
    ],
    projectFiles: async () => files,
  };

  return {
    coordinator,
    calls,
    drafts,
    app: coordinator as unknown as Coordinator,
  };
}

/** a prompt store holding `found` for the fake conversation's /work and nothing elsewhere, recording what the app adds. */
export function prompts(found: string[]) {
  const added: [string, string][] = [];

  return {
    added,
    store: {
      prompts: async (cwd: string) => (cwd === '/work' ? found : []),
      addPrompt: async (cwd: string, text: string) => {
        added.push([cwd, text]);
      },
    },
  };
}

export const ENTER = '\u001b[13u';

export const SHIFT_ENTER = '\u001b[13;2u';

export const DOWN = '\u001b[B';

export const UP = '\u001b[A';

export const LEFT = '\u001b[D';

export const TAB = '\u001b[9u';

/** types `command`, submits it and waits for its view to show `text`. */
export async function openCommand(
  ui: ReturnType<typeof show>,
  command: string,
  text: string,
) {
  ui.stdin.write(command);

  await delay(30);

  ui.stdin.write(ENTER);

  await until(`${command} to show ${text}`, () => ui.text().includes(text));
}

export const tools = (prefix: string) =>
  [1, 2].map((n) => ({
    id: `${prefix}-tool-${n}`,
    kind: 'tool' as const,
    title: `${prefix} tool ${n}`,
    text: `${prefix} output ${n}`,
    cwd: '/work',
    done: true,
  }));

export const approval = {
  id: 'r1',
  kind: 'approval' as const,
  title: 'rm -rf build',
  detail: '{}',
};

/** opens the command picker and waits for it. */
export async function commands(ui: ReturnType<typeof show>) {
  ui.stdin.write('\u0010');

  await until('the command picker', () => ui.text().includes('Commands'));

  await delay(30);
}

/** an SGR report of the left button at a zero-based cell: down, held moving there, or up. */
export const left = (
  kind: 'press' | 'drag' | 'release',
  column: number,
  row: number,
) =>
  `\u001b[<${kind === 'drag' ? 32 : 0};${column + 1};${row + 1}${kind === 'release' ? 'm' : 'M'}`;

/** a left press at `from`, held motion to `to` and the release there, each its own read. */
export function drag(
  ui: ReturnType<typeof show>,
  from: [number, number],
  to: [number, number],
) {
  ui.stdin.write(left('press', ...from));

  ui.stdin.write(left('drag', ...to));

  ui.stdin.write(left('release', ...to));
}
