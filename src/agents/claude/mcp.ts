import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from '../types.js';

export class ClaudeMcp {
  private readonly reportedMcp = new Set<string>();
  private mcpTimer?: ReturnType<typeof setTimeout>;
  private mcpReading = false;
  private mcpRequested = false;
  private mcpPending = false;

  constructor(
    private readonly query: Query,
    private readonly closed: () => boolean,
    private readonly emit: (event: AgentEvent) => void,
  ) {}

  refresh(): void {
    if (this.closed()) return;

    clearTimeout(this.mcpTimer);
    this.mcpTimer = undefined;
    this.mcpRequested = true;

    if (!this.mcpReading) void this.readMcpStatus();
  }

  private async readMcpStatus(): Promise<void> {
    this.mcpReading = true;

    try {
      do {
        this.mcpRequested = false;

        try {
          const servers = await this.query.mcpServerStatus();

          if (this.closed()) return;

          // cached discovery also reports pending, but its tools do not need a startup poll.
          this.mcpPending = servers.some(
            ({ status, tools }) => status === 'pending' && tools === undefined,
          );

          for (const { name, status, error } of servers) {
            if (status !== 'failed' && status !== 'needs-auth') continue;

            const key = JSON.stringify([name, status]);

            if (this.reportedMcp.has(key)) continue;

            this.reportedMcp.add(key);

            this.emit({
              type: 'notice',
              text:
                status === 'needs-auth'
                  ? `Claude MCP server ${name} needs sign-in.`
                  : `Claude could not connect to MCP server ${name}${error ? `: ${error}` : '.'}`,
              transient: true,
            });
          }
        } catch {
          // a failed diagnostic read must not interrupt the conversation.
        }
      } while (this.mcpRequested && !this.closed());
    } finally {
      this.mcpReading = false;

      if (this.mcpPending && !this.closed()) {
        this.mcpTimer = setTimeout(() => this.refresh(), 1000);
        this.mcpTimer.unref();
      }
    }
  }

  stop(): void {
    clearTimeout(this.mcpTimer);
    this.mcpTimer = undefined;
    this.mcpRequested = false;
  }
}
