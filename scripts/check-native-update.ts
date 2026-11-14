import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { installedAgents } from '../src/agents/registry.js';
import {
  inspectRuntime,
  runtimeSchema,
} from '../src/agents/updates/runtime-updates.js';
import {
  prepareNativeUpdate,
  verifyNativeUpdate,
} from '../src/agents/updates/native-verification.js';
import { verificationAdapter } from '../src/agents/updates/native-verification-profile.js';
import { writeJson } from '../src/persistence/json.js';
import { runtimeBuildIdentity } from '../src/core/runtime/runtime-updates.js';

const { values } = parseArgs({
  options: {
    runtime: { type: 'string' },
    executable: { type: 'string' },
    'previous-executable': { type: 'string' },
    model: { type: 'string' },
    out: { type: 'string' },
    'allow-account-usage': { type: 'boolean', default: false },
  },
});

const runtime = runtimeSchema.parse(values.runtime);

assert.ok(
  values.executable && values.out,
  '--executable and --out are required',
);

const directory = resolve(values.out);
await mkdir(directory);

const registration = (await installedAgents()).find(
  (value) => value.adapter.id === runtime,
)!;

const signal = AbortSignal.timeout(15 * 60_000);

const candidate = await inspectRuntime(
  { ...registration, executable: resolve(values.executable) },
  signal,
);

if (!values['allow-account-usage']) {
  const adapter = await verificationAdapter(runtime, directory);

  const models = await adapter.models({
    executable: candidate.executable,
    cwd: directory,
    signal,
  });

  await writeJson(resolve(directory, 'startup.json'), {
    candidate,
    models: models.map((model) => model.id),
    qualified: false,
  });

  console.log('Native startup passed. Full compatibility was not checked.');
} else {
  assert.ok(
    values['previous-executable'],
    '--previous-executable is required for qualification',
  );

  const previous = await inspectRuntime(
    { ...registration, executable: resolve(values['previous-executable']) },
    signal,
  );

  const options = {
    directory,
    build: await runtimeBuildIdentity(),
    model: values.model,
    allowAccountUsage: true,
    signal,
    progress: console.log,
  };

  const prepared = await prepareNativeUpdate(previous, options);
  await writeJson(resolve(directory, 'prepared.json'), prepared);
  const report = await verifyNativeUpdate(prepared, candidate, options);
  console.log(JSON.stringify(report, null, 2));
}
