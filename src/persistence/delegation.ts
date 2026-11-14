import { mkdir } from 'node:fs/promises';

import { join } from 'node:path';

import { defaultPolicy, policySchema } from '../core/routing.js';

import type { Policy } from '../core/routing.js';

import { errorMessage } from '../errors.js';

import { readJson, writeJson } from './json.js';

/** one policy per state directory, so every Witch on it routes the same way. */
export class DelegationStore {
  private constructor(private readonly file: string) {}

  static async open(directory: string): Promise<DelegationStore> {
    await mkdir(directory, { recursive: true, mode: 0o700 });

    return new DelegationStore(join(directory, 'policy.json'));
  }

  async read(): Promise<Policy> {
    try {
      return (await readJson(this.file, policySchema)) ?? defaultPolicy;
    } catch (error) {
      throw new Error(
        `The delegation policy at ${this.file} is unreadable; fix or delete it. ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  write(policy: Policy): Promise<void> {
    return writeJson(this.file, policySchema.parse(policy));
  }
}
