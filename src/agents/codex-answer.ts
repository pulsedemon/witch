import { z } from 'zod';
import type { JsonRpc } from './json-rpc.js';

const object = z.record(z.string(), z.unknown());
const configuration = z.object({ config: object });
const servers = z.object({
  data: z.array(
    z.object({ runtimeStatus: z.string().nullish(), tools: object }),
  ),
  nextCursor: z.string().nullish(),
});

function readProfile(
  value: unknown,
  requestFile?: string,
): Record<string, unknown> {
  const profile = object.parse(value);
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
  const { config: source } = configuration.parse(
    await rpc.request('config/read', { cwd, includeLayers: false }),
  );
  const config: Record<string, unknown> = {
    'features.apps': false,
    'features.plugins': false,
    'features.hooks': false,
    notify: [],
    'features.multi_agent': false,
    'features.multi_agent_v2': false,
    'features.skill_mcp_dependency_install': false,
    mcp_servers: Object.fromEntries(
      Object.keys(object.parse(source.mcp_servers ?? {})).map((name) => [
        name,
        { enabled: false },
      ]),
    ),
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

export async function checkAnswerTools(rpc: JsonRpc, threadId: string) {
  let cursor: string | null | undefined;
  do {
    const page = servers.parse(
      await rpc.request('mcpServerStatus/list', {
        threadId,
        cursor,
        limit: 100,
      }),
    );
    if (
      page.data.some(
        (server) =>
          server.runtimeStatus !== 'disabled' ||
          Object.keys(server.tools).length > 0,
      )
    )
      throw new Error('Codex exposed MCP tools to a peer answer.');
    cursor = page.nextCursor;
  } while (cursor);
}
