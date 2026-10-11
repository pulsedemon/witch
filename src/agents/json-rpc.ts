import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { z } from 'zod';

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

export class JsonRpc {
  onMessage: (message: RpcMessage) => void = () => {};
  onExit: (error: Error) => void = () => {};
  private sequence = 0;
  private pending = new Map<
    number,
    ReturnType<typeof Promise.withResolvers<unknown>>
  >();
  private failure?: Error;
  private stderr = '';
  private closed = Promise.withResolvers<void>();

  constructor(private readonly process: ChildProcessWithoutNullStreams) {
    const lines = createInterface({ input: process.stdout });
    lines.on('line', (line) => {
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
    });
    process.stderr.setEncoding('utf8');
    process.stderr.on('data', (text: string) => {
      this.stderr = (this.stderr + text).slice(-4096);
    });
    process.stdin.on('error', (error) => this.fail(error));
    process.on('error', (error) => this.fail(error));
    process.on('close', (code, signal) => {
      lines.close();
      this.fail(
        new Error(
          `Agent process exited (${signal ?? code})${this.stderr.trim() ? `: ${this.stderr.trim()}` : ''}`,
        ),
      );
      this.closed.resolve();
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

  async close(): Promise<void> {
    this.process.stdin.end();
    if (this.process.exitCode === null && this.process.signalCode === null) {
      this.process.kill('SIGTERM');
    }
    await this.closed.promise;
  }

  private write(message: RpcMessage): void {
    if (this.failure) throw this.failure;
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.onExit(error);
  }
}
