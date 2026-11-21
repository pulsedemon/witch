import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

export interface WireFrame {
  direction: 'client' | 'server';
  message: unknown;
}

export function normalizeWire(
  value: unknown,
  cwd: string,
  home: string,
): unknown {
  const identities: Record<string, string> = {
    '/message/response/response/account/email': 'native@example.invalid',
    '/message/response/response/account/organization': 'native account',
    '/message/result/accountId': 'native-account',
    '/message/params/serverName': 'native-machine.invalid',
    '/message/params/installationId': 'native-installation',
  };

  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');

  const normalize = (input: unknown, path: string): unknown => {
    if (typeof input === 'string')
      return (
        identities[path] ??
        input
          .replaceAll(encoded, '-native-project')
          .replaceAll(cwd, '/native/project')
          .replaceAll(home, '/home/native')
      );

    if (Array.isArray(input))
      return input.map((child) => normalize(child, path));

    if (input && typeof input === 'object')
      return Object.fromEntries(
        Object.entries(input).map(([key, child]) => [
          key,
          normalize(child, `${path}/${key}`),
        ]),
      );

    return input;
  };

  return normalize(value, '');
}

export function replayWire(
  files: string[],
  cwd: string,
  options: { fragmentBytes?: number; gates?: number[][] } = {},
): {
  launch(): ChildProcessWithoutNullStreams;

  finished(): Promise<void>;

  paused(stream: number, frame: number): Promise<void>;

  release(stream: number): void;
} {
  const children: ChildProcessWithoutNullStreams[] = [];
  const completions: Promise<void>[] = [];

  const pauses = new Map<
    string,
    ReturnType<typeof Promise.withResolvers<void>>
  >();

  const pause = (stream: number, frame: number) => {
    const key = `${stream}/${frame}`;

    if (!pauses.has(key)) pauses.set(key, Promise.withResolvers<void>());

    return pauses.get(key)!;
  };

  return {
    launch() {
      const index = children.length;
      assert.ok(files[index], `Unexpected native process ${index}`);

      const child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL('./native-replay.mjs', import.meta.url)),
          files[index]!,
          String(options.fragmentBytes ?? 0),
          JSON.stringify(options.gates?.[index] ?? []),
        ],
        { cwd, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] },
      ) as ChildProcessWithoutNullStreams;

      children.push(child);
      let stderr = '';

      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });

      child.on('message', (message: { paused?: number }) => {
        if (message.paused !== undefined)
          pause(index, message.paused).resolve();
      });

      const completion = new Promise<void>((resolve, reject) => {
        child.once('error', reject);

        child.once('close', (code, signal) => {
          if (code === 0) resolve();
          else
            reject(new Error(`Replay ${index}: ${stderr || signal || code}`));
        });
      });

      void completion.catch(() => {});
      completions.push(completion);

      return child;
    },
    paused: (stream, frame) => pause(stream, frame).promise,
    release: (stream) => {
      children[stream]!.send({ release: true });
    },
    async finished() {
      await Promise.all(completions);

      assert.equal(
        children.length,
        files.length,
        'Every recorded process must be replayed',
      );
    },
  };
}

export function observeWire(
  child: ChildProcessWithoutNullStreams,
  onFrame?: (frame: WireFrame) => void,
): {
  frames: WireFrame[];
  finished(): Promise<void>;
} {
  const frames: WireFrame[] = [];
  let failure: unknown;

  const append = (direction: WireFrame['direction'], line: string) => {
    const frame = { direction, message: JSON.parse(line) as unknown };
    frames.push(frame);
    onFrame?.(frame);
  };

  const readers = new Map<
    WireFrame['direction'],
    { decoder: StringDecoder; pending: string }
  >(
    ['client', 'server'].map((direction) => [
      direction as WireFrame['direction'],
      {
        decoder: new StringDecoder('utf8'),
        pending: '',
      },
    ]),
  );

  const read = (
    direction: WireFrame['direction'],
    chunk: string | Uint8Array,
  ) => {
    const reader = readers.get(direction)!;
    reader.pending += reader.decoder.write(Buffer.from(chunk));
    const lines = reader.pending.split('\n');
    reader.pending = lines.pop()!;

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        append(direction, line);
      } catch (error) {
        failure ??= error;
      }
    }
  };

  const write = child.stdin.write;

  child.stdin.write = (...args) => {
    read('client', args[0] as string | Uint8Array);

    return Reflect.apply(write, child.stdin, args) as boolean;
  };

  child.stdout.on('data', (chunk: Buffer | string) => read('server', chunk));

  child.on('error', (error) => {
    failure ??= error;
  });

  const closed = new Promise<void>((resolve) =>
    child.once('close', () => resolve()),
  );

  return {
    frames,
    async finished() {
      await closed;

      if (failure) throw failure;

      for (const [direction, reader] of readers) {
        const tail = reader.pending + reader.decoder.end();

        if (tail.trim()) append(direction, tail);

        reader.pending = '';
      }
    },
  };
}
