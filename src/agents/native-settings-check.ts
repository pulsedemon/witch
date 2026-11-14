import assert from 'node:assert/strict';

import { execFile } from 'node:child_process';

import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { join } from 'node:path';

import { promisify } from 'node:util';

import { verificationAdapter } from './native-verification-profile.js';

import { probeApproval } from './native-scenario.js';

import type { RuntimeInstallation } from './runtime-updates.js';

import type { AgentEvent, AgentSession } from './types.js';

import { writeJson } from '../persistence/json.js';

/** only synthetic settings are loaded; the probe records their effect in a real native tool process. */
export async function checkNativeSettings(
  candidate: RuntimeInstallation,
  model: string,
  directory: string,
  signal: AbortSignal,
): Promise<void> {
  const cwd = join(directory, 'project');

  const config = join(directory, 'config');

  const projectConfig = join(
    cwd,
    candidate.runtime === 'claude' ? '.claude' : '.codex',
  );

  await mkdir(config, { recursive: true });

  await mkdir(projectConfig, { recursive: true });

  await promisify(execFile)('git', ['init', '-q'], { cwd });

  const expected: Record<string, string> = {
    WITCH_SETTINGS_USER: 'user-source',
    WITCH_SETTINGS_PROJECT: 'project-source',
    WITCH_SETTINGS_ORDER:
      candidate.runtime === 'claude' ? 'local-wins' : 'project-wins',
  };

  if (candidate.runtime === 'claude') {
    await writeJson(join(config, 'settings.json'), {
      env: {
        WITCH_SETTINGS_USER: 'user-source',
        WITCH_SETTINGS_ORDER: 'user-loses',
      },
    });

    await writeJson(join(projectConfig, 'settings.json'), {
      env: {
        WITCH_SETTINGS_PROJECT: 'project-source',
        WITCH_SETTINGS_ORDER: 'project-loses',
      },
    });

    await writeJson(join(projectConfig, 'settings.local.json'), {
      env: {
        WITCH_SETTINGS_LOCAL: 'local-source',
        WITCH_SETTINGS_ORDER: 'local-wins',
      },
    });

    expected.WITCH_SETTINGS_LOCAL = 'local-source';
  } else {
    await writeFile(
      join(config, 'config.toml'),
      `[projects.${JSON.stringify(cwd)}]\ntrust_level = "trusted"\n[shell_environment_policy.set]\nWITCH_SETTINGS_USER = "user-source"\nWITCH_SETTINGS_ORDER = "user-loses"\n`,
    );

    await writeFile(
      join(projectConfig, 'config.toml'),
      '[shell_environment_policy.set]\nWITCH_SETTINGS_PROJECT = "project-source"\nWITCH_SETTINGS_ORDER = "project-wins"\n',
    );
  }

  await writeFile(
    join(cwd, 'probe.mjs'),
    `import {writeFileSync} from 'node:fs'; writeFileSync('settings-result.json', JSON.stringify(Object.fromEntries(${JSON.stringify(Object.keys(expected))}.map(key => [key, process.env[key]])))); console.log('SETTINGS_RECORDED');\n`,
  );

  const adapter = await verificationAdapter(candidate.runtime, directory, {
    ordinarySettings: true,
  });

  const events: AgentEvent[] = [];

  const failure = new AbortController();

  const session: AgentSession = await adapter.connect({
    executable: candidate.executable,
    cwd,
    model,
    effort: 'low',
    memoryDirectories: [],
    signal: AbortSignal.any([signal, failure.signal]),
    onProcess: async () => {},
    onEvent: (event) => {
      events.push(event);

      if (event.type === 'request') {
        try {
          session!.respond(event.request.id, probeApproval(event.request));
        } catch (error) {
          failure.abort(error);
        }
      }
    },
  });

  try {
    const result = await session.send(
      'Run exactly `node probe.mjs` once, requesting native approval if needed. Do not inspect or edit files, load skills or delegate. Reply only DONE after the command completes.',
    );

    assert.equal(result.status, 'completed', result.error);

    assert.deepEqual(
      JSON.parse(await readFile(join(cwd, 'settings-result.json'), 'utf8')),
      expected,
    );
  } catch (error) {
    // a failed approval aborts the session, so the turn's own failure only says it was aborted
    throw failure.signal.aborted ? failure.signal.reason : error;
  } finally {
    try {
      await session.close();
    } finally {
      await writeJson(join(directory, 'events.json'), events);
    }
  }
}
