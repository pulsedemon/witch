import { z } from 'zod';
import { pages } from './json-rpc.js';
import type { JsonRpc } from './json-rpc.js';
import { object, readConfig, withoutMcp } from './codex-config.js';

const servers = z.object({
  data: z.array(
    z.object({ runtimeStatus: z.string().nullish(), tools: object }),
  ),
  nextCursor: z.string().nullish(),
});

/** config/read emits unset options as null; native TOML overrides require them to be absent. */
function tomlSettings(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(tomlSettings);

  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, value]) => value !== null)
        .map(([name, value]) => [name, tomlSettings(value)]),
    );

  return value;
}

function readProfile(
  value: unknown,
  requestFile?: string,
): Record<string, unknown> {
  const profile = object.parse(tomlSettings(value));
  const filesystem = object.parse(profile.filesystem ?? {});

  return {
    ...profile,
    ...(profile.extends === ':workspace' ? { extends: ':read-only' } : {}),
    filesystem: {
      ...Object.fromEntries(
        Object.entries(filesystem).map(([path, access]) => [
          path,
          access === 'write'
            ? 'read'
            : typeof access === 'object' && access !== null
              ? Object.fromEntries(
                  Object.entries(object.parse(access)).map(([scope, mode]) => [
                    scope,
                    mode === 'write' ? 'read' : mode,
                  ]),
                )
              : access,
        ]),
      ),
      ...(requestFile ? { [requestFile]: 'read' } : {}),
    },
    network: { ...object.parse(profile.network ?? {}), enabled: false },
  };
}

export async function answerConfiguration(
  rpc: JsonRpc,
  cwd: string,
  requestFile: string,
  profile?: string,
): Promise<{
  config: Record<string, unknown>;
  approvalPolicy: 'never';
  ephemeral: true;
  permissions?: string;
  sandbox?: 'read-only';
}> {
  const source = await readConfig(rpc, cwd);

  const config: Record<string, unknown> = {
    ...withoutMcp(source),
    'features.hooks': false,
    notify: [],
    'features.multi_agent': false,
    'features.multi_agent_v2': false,
  };

  const named = profile !== undefined && !profile.startsWith(':');

  if (named) {
    const profiles = object.parse(source.permissions ?? {});

    if (!(profile in profiles))
      throw new Error(`Codex did not return permission profile ${profile}.`);

    config.permissions = Object.fromEntries(
      Object.entries(profiles).map(([name, value]) => [
        name,
        readProfile(value, name === profile ? requestFile : undefined),
      ]),
    );
  }

  return {
    config,
    approvalPolicy: 'never',
    ephemeral: true,
    ...(named ? { permissions: profile } : { sandbox: 'read-only' }),
  };
}

export async function checkNoMcpTools(
  rpc: JsonRpc,
  threadId: string,
  holder: string,
) {
  for await (const data of pages(
    rpc,
    'mcpServerStatus/list',
    { threadId, limit: 100 },
    servers,
  ))
    if (
      data.some(
        (server) =>
          server.runtimeStatus !== 'disabled' ||
          Object.keys(server.tools).length > 0,
      )
    )
      throw new Error(`Codex exposed MCP tools to ${holder}.`);
}
