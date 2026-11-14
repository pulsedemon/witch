import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { z } from 'zod';
import { readLines, watchChild, withTail } from '../stderr.js';
import type { ChildExit } from '../stderr.js';
import { running, stopDeadline, terminateChild } from '../shutdown.js';
import type { AgentStopOptions } from '../types.js';

const envelope = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z
    .object({ message: z.string(), code: z.number().optional() })
    .optional(),
});

export type RpcMessage = z.infer<typeof envelope>;

/** each page of an app-server list; the first request sends `params` exactly, since the native replays compare its keys. */
export async function* pages<T>(
  rpc: JsonRpc,
  method: string,
  params: Record<string, unknown>,
  schema: z.ZodType<{ data: T[]; nextCursor?: string | null }>,
): AsyncGenerator<T[]> {
  let request = params;

  for (;;) {
    const page = schema.parse(await rpc.request(method, request));

    yield page.data;

    if (!page.nextCursor) return;

    request = { ...params, cursor: page.nextCursor };
  }
}

export class JsonRpc {
  onMessage: (message: RpcMessage) => void = () => {};
  onExit: (error: Error) => void = () => {};
  private sequence = 0;
  private pending = new Map<
    number,
    ReturnType<typeof Promise.withResolvers<unknown>>
  >();
  private failure?: Error;
  private readonly child: ChildExit;
  private closing?: Promise<boolean>;

  constructor(private readonly process: ChildProcessWithoutNullStreams) {
    this.child = watchChild(process);

    readLines(process.stdout, (line) => this.receive(line));

    process.stdin.on('error', (error) => this.fail(error));

    process.on('error', (error) => this.fail(error));

    process.on('close', (code, signal) => {
      this.fail(
        new Error(
          withTail(
            `Agent process exited (${signal ?? code})`,
            this.child.tail(),
          ),
        ),
      );
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);

    const id = ++this.sequence;
    const result = Promise.withResolvers<unknown>();

    this.pending.set(id, result);

    this.write({ id, method, params });

    return result.promise;
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, params });
  }

  respond(id: string | number, result: unknown): void {
    this.write({ id, result });
  }

  reject(id: string | number, message: string): void {
    this.write({ id, error: { code: -32601, message } });
  }

  close(options: AgentStopOptions = {}): Promise<boolean> {
    return (this.closing ??= this.stop(options));
  }

  private async stop(options: AgentStopOptions): Promise<boolean> {
    this.process.stdin.end();

    if (!options.restart)
      return terminateChild(
        this.process,
        this.child.closed,
        stopDeadline(options.deadline),
      );

    // killing in the tick after a failed spawn signals the caller's whole process group
    if (running(this.process)) this.process.kill('SIGTERM');

    await this.child.closed;

    return false;
  }

  private write(message: RpcMessage): void {
    if (this.failure) throw this.failure;

    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string): void {
    try {
      const message = envelope.parse(JSON.parse(line));

      if (message.method) {
        this.onMessage(message);
      } else if (typeof message.id === 'number') {
        const request = this.pending.get(message.id);

        this.pending.delete(message.id);

        if (message.error) request?.reject(new Error(message.error.message));
        else request?.resolve(message.result);
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;

    this.failure = error;

    // a failed spawn has already set exitCode
    if (this.process.exitCode === null && this.process.signalCode === null)
      this.process.kill();

    for (const request of this.pending.values()) request.reject(error);

    this.pending.clear();

    this.onExit(error);
  }
}
