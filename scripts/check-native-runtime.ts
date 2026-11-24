import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { nativeExecutable } from '../src/agents/executable.js';
import {
  inspectArtifact,
  runtimeSchema,
} from '../src/agents/native-check/artifact.js';
import {
  prepareNativeCheck,
  runNativeCheck,
} from '../src/agents/native-check/native-verification.js';
import { verificationAdapter } from '../src/agents/native-check/native-verification-profile.js';
import { writeJson } from '../src/persistence/json.js';

const { values } = parseArgs({
  options: {
    runtime: { type: 'string' },
    executable: { type: 'string' },
    'previous-root': { type: 'string' },
    model: { type: 'string' },
    out: { type: 'string' },
    'allow-account-usage': { type: 'boolean', default: false },
  },
});

const runtime = runtimeSchema.parse(values.runtime);
assert.ok(values.out, '--out is required');
// the `..` in a pinned path must reach the OS unnormalized, so neither path goes through `resolve`
const candidatePath = values.executable ?? nativeExecutable(runtime);

assert.ok(
  candidatePath,
  'Run pnpm install first: the pinned native CLI is missing',
);

const previousPath =
  values['previous-root'] &&
  nativeExecutable(runtime, {
    environment: {},
    root: resolve(values['previous-root']),
  });

if (values['previous-root'])
  assert.ok(
    previousPath,
    `No pinned ${runtime} under ${values['previous-root']}`,
  );

console.log(`Candidate: ${candidatePath}`);

if (previousPath) console.log(`Previous: ${previousPath}`);

const directory = resolve(values.out);
await mkdir(directory);
const signal = AbortSignal.timeout(15 * 60_000);
const candidate = await inspectArtifact(runtime, candidatePath, signal);

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
  assert.ok(previousPath, '--previous-root is required for qualification');

  const options = {
    directory,
    model: values.model,
    allowAccountUsage: true,
    signal,
    progress: console.log,
  };

  const prepared = await prepareNativeCheck(
    await inspectArtifact(runtime, previousPath, signal),
    options,
  );

  await writeJson(resolve(directory, 'prepared.json'), prepared);
  const report = await runNativeCheck(prepared, candidate, options);
  console.log(JSON.stringify(report, null, 2));
}
