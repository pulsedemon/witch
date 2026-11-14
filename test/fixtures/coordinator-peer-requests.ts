import assert from 'node:assert/strict';
import { vi } from 'vitest';
import type { TaskClaim } from '../../src/core/coordination-state.js';
import type { PeerRequest } from '../../src/core/peer-requests.js';
import { callControl } from '../../src/persistence/control.js';
import { orderedCleanup } from './cleanup.js';
import type { RegisterCleanup } from './cleanup.js';
import type { coordinationFixture } from './coordination.js';
import { pauseDiscovery, unitCoordinationFixture } from './coordination.js';

export type Fixture = Awaited<ReturnType<typeof coordinationFixture>>;

export type Client = Awaited<ReturnType<Fixture['start']>>;

export const secret = 'peer-only-text';

export async function claimed(
  client: Client,
  name: string,
): Promise<TaskClaim> {
  const result = await client.claim(`task:${name}`, `${name} work`);

  if (result.kind !== 'claimed') assert.fail(JSON.stringify(result));

  return result.claim;
}

export async function ask(
  client: Client,
  claim: TaskClaim,
  message: string,
): Promise<PeerRequest> {
  const result = await callControl(await client.binding(), {
    kind: 'ask',
    claim: claim.id,
    message,
  });

  if (result.kind !== 'peer-request') assert.fail(JSON.stringify(result));

  return result.request;
}

/** A runs the asker and B the owner, with discovery ticks under the test's control. */
export async function owners(
  register: RegisterCleanup,
  task = 'b-work',
  createFixture = unitCoordinationFixture,
) {
  const refreshes = pauseDiscovery(vi.spyOn);
  const f = await createFixture(orderedCleanup(register));
  const a = await f.start('A');
  const b = await f.start('B');
  const claim = await claimed(b, task);
  const seen = { answering: false };

  b.coordinator.subscribe(() => {
    if (b.coordinator.snapshot.answering) seen.answering = true;
  });

  return { f, a, b, claim, seen, refreshes };
}

/** the refresh a discovery tick runs, awaited; it renotifies while requests are answerable. */
export const refreshed = (client: Client) => client.coordination.context();

export const answerTurns = (client: Client) =>
  client.a.inputs.filter(({ author }) => author === 'witch');

export const notice = (client: Client, id: string) =>
  client.coordinator.snapshot.items.find((item) => item.id === id);

export const settled = (client: Client) =>
  client.coordinator.snapshot.phase === 'idle' &&
  !client.coordinator.snapshot.answering;

export const stored = async (f: Fixture, request: PeerRequest) =>
  (await f.registry.peerRequests(request.project, request.to)).find(
    ({ id }) => id === request.id,
  )!;

export const listed = (context = ''): string[] => {
  const paragraph = context
    .split('\n\n')
    .find((text) =>
      text.startsWith('These peer requests have recorded answers'),
    );

  return paragraph
    ? (
        JSON.parse(paragraph.slice(paragraph.indexOf('\n') + 1)) as {
          id: string;
        }[]
      ).map(({ id }) => id)
    : [];
};
