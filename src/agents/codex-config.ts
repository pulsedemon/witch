import { z } from 'zod';

import type { JsonRpc } from './json-rpc.js';

export const object = z.record(z.string(), z.unknown());

const configuration = z.object({ config: object });

export async function readConfig(
  rpc: JsonRpc,
  cwd: string,
): Promise<Record<string, unknown>> {
  return configuration.parse(
    await rpc.request('config/read', { cwd, includeLayers: false }),
  ).config;
}

/** Codex has no single switch for every MCP server, so each configured one is disabled by name. */
export function withoutMcp(
  source: Record<string, unknown>,
): Record<string, unknown> {
  return {
    'features.apps': false,
    'features.plugins': false,
    'features.skill_mcp_dependency_install': false,
    mcp_servers: Object.fromEntries(
      Object.entries(object.parse(source.mcp_servers ?? {})).map(
        ([name, value]) => {
          const server = object.parse(value);

          // disabled servers still need a valid transport; config/read's null options are not TOML overrides.
          return [
            name,
            {
              ...(typeof server.command === 'string'
                ? { command: server.command }
                : { url: server.url }),
              enabled: false,
            },
          ];
        },
      ),
    ),
  };
}
