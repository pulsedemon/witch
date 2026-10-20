import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  claimInputSchema,
  sessionPresenceSchema,
  taskClaimSchema,
  taskReference,
} from '../core/coordination-state.js';
import type {
  ClaimInput,
  ClaimOwner,
  SessionPresence,
  TaskClaim,
} from '../core/coordination-state.js';
import { exclusiveLock, isLocked } from './lock.js';
import { writeJson } from './json.js';

const ledgerSchema = z.object({
  version: z.literal(1),
  claims: z.array(taskClaimSchema),
});

export class ClaimConflict extends Error {
  constructor(readonly claim: TaskClaim) {
    super(
      `Task already reserved by ${claim.owner.conversation}: ${claim.summary}`,
    );
  }
}

export function checkDeadline(deadline: number): void {
  if (Date.now() >= deadline) throw new Error('Coordination request expired.');
}

export class CoordinationStore {
  private constructor(private readonly directory: string) {}

  static async open(root: string): Promise<CoordinationStore> {
    const directory = join(root, 'coordination');
    await mkdir(join(directory, 'sessions'), { recursive: true, mode: 0o700 });
    return new CoordinationStore(directory);
  }

  async presences(): Promise<SessionPresence[]> {
    const directory = join(this.directory, 'sessions');
    const result: SessionPresence[] = [];
    for (const name of await readdir(directory)) {
      if (!name.endsWith('.json')) continue;
      const text = await readFile(join(directory, name), 'utf8').catch(
        (error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
          throw error;
        },
      );
      if (text !== undefined)
        result.push(sessionPresenceSchema.parse(JSON.parse(text)));
    }
    return result;
  }

  async publish(presence: SessionPresence): Promise<void> {
    await writeJson(
      join(this.directory, 'sessions', `${presence.id}.json`),
      sessionPresenceSchema.parse(presence),
    );
  }

  /** a failed presence removal cannot register a later holder of the conversation lock. */
  async holdActivation(activation: string): Promise<() => Promise<void>> {
    const file = join(this.directory, 'sessions', `${activation}.lock`);
    const lock = await open(
      file,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_RDWR |
        constants.O_NONBLOCK |
        exclusiveLock,
      0o600,
    );
    return async () => {
      await lock.close();
      await unlink(file).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    };
  }

  isActive(activation: string): Promise<boolean> {
    return isLocked(join(this.directory, 'sessions', `${activation}.lock`));
  }

  /** the caller holds the conversation lock until its writer drains and this removal finishes. */
  async removePresence(
    conversation: string,
    activation: string,
  ): Promise<void> {
    const file = join(this.directory, 'sessions', `${conversation}.json`);
    try {
      const presence = sessionPresenceSchema.parse(
        JSON.parse(await readFile(file, 'utf8')),
      );
      if (presence.activation === activation) await unlink(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async claims(): Promise<TaskClaim[]> {
    try {
      return ledgerSchema.parse(
        JSON.parse(await readFile(join(this.directory, 'claims.json'), 'utf8')),
      ).claims;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async claim(
    owner: ClaimOwner,
    input: ClaimInput,
    deadline: number,
    verify: () => Promise<void>,
  ): Promise<TaskClaim> {
    const { reference, aliases = [], summary } = claimInputSchema.parse(input);
    const references = [
      ...new Set(
        [reference, ...aliases].map((value) =>
          taskReference(value, owner.project),
        ),
      ),
    ];
    return this.mutate(deadline, verify, (claims) => {
      const conflict = claims.find(
        (claim) =>
          claim.owner.conversation !== owner.conversation &&
          claim.references.some((value) => references.includes(value)),
      );
      if (conflict) throw new ClaimConflict(conflict);
      const existing = claims.find(
        (claim) => claim.owner.conversation === owner.conversation,
      );
      if (existing) {
        if (
          existing.owner.project !== owner.project ||
          !references.some((value) => existing.references.includes(value))
        )
          throw new Error('Release the current task before claiming another.');
        existing.references = [
          ...new Set([...existing.references, ...references]),
        ];
        existing.summary = summary;
        return existing;
      }
      const claim: TaskClaim = {
        id: randomUUID(),
        owner,
        references,
        summary,
        createdAt: Date.now(),
      };
      claims.push(claim);
      return claim;
    });
  }

  async release(
    owner: ClaimOwner,
    id: string,
    deadline: number,
    verify: () => Promise<void>,
  ): Promise<void> {
    await this.mutate(deadline, verify, (claims) => {
      const index = claims.findIndex((claim) => claim.id === id);
      if (index < 0) return;
      const claim = claims[index]!;
      if (
        claim.owner.conversation !== owner.conversation ||
        claim.owner.project !== owner.project
      )
        throw new Error('Only the owning conversation can release this task.');
      claims.splice(index, 1);
    });
  }

  private async mutate<T>(
    deadline: number,
    verify: () => Promise<void>,
    change: (claims: TaskClaim[]) => T,
  ): Promise<T> {
    const lock = await this.lock(deadline);
    try {
      const claims = await this.claims();
      const before = JSON.stringify(claims);
      await verify();
      checkDeadline(deadline);
      const result = change(claims);
      if (JSON.stringify(claims) !== before)
        await writeJson(join(this.directory, 'claims.json'), {
          version: 1,
          claims,
        });
      return result;
    } finally {
      await lock.close();
    }
  }

  private async lock(deadline: number): Promise<FileHandle> {
    while (true) {
      checkDeadline(deadline);
      try {
        return await open(
          join(this.directory, 'lock'),
          constants.O_RDWR |
            constants.O_CREAT |
            constants.O_NONBLOCK |
            exclusiveLock,
          0o600,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error;
        await delay(Math.min(25, Math.max(0, deadline - Date.now())));
      }
    }
  }
}
