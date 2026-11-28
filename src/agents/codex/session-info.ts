import { z } from 'zod';
import type { SessionInfo } from '../types.js';

const activePermissionProfile = z.object({ id: z.string() }).nullish();

export function reviewPermissionSettings(mailbox: string) {
  const permissions = 'witch-read-only-review';

  return {
    permissions,
    approvalPolicy: 'never',
    config: {
      permissions: {
        [permissions]: {
          extends: ':read-only',
          // saved command grants keep the sandbox when the thread restricts reads
          filesystem: { [mailbox]: 'deny' },
          network: { enabled: false },
        },
      },
    },
  };
}

const readOnlySession = z.object({
  approvalPolicy: z.literal('never'),
  sandbox: z.object({
    type: z.literal('readOnly'),
    networkAccess: z.literal(false),
  }),
  activePermissionProfile,
});

export function requireReadOnlySession(value: unknown, profile?: string): void {
  const result = readOnlySession.safeParse(value);

  if (
    !result.success ||
    (profile && result.data.activePermissionProfile?.id !== profile)
  )
    throw new Error(
      'Codex did not grant read-only permissions without network or approvals.',
    );
}

const session = z.object({
  thread: z.object({ id: z.string() }),
  model: z.string(),
  approvalPolicy: z.unknown(),
  approvalsReviewer: z.string().optional(),
  reasoningEffort: z.string().nullish(),
  activePermissionProfile,
});

export function permissionProfile(value: unknown): string | undefined {
  return activePermissionProfile.parse(value)?.id;
}

export function sessionInfo(value: unknown, current: SessionInfo): SessionInfo {
  const data = session.parse(value);

  const policy =
    typeof data.approvalPolicy === 'string'
      ? data.approvalPolicy
      : JSON.stringify(data.approvalPolicy);

  return {
    ...current,
    id: data.thread.id,
    model: data.model,
    nativeEffort: data.reasoningEffort ?? undefined,
    permissionMode: `${policy}${data.approvalsReviewer ? ` / ${data.approvalsReviewer}` : ''}`,
    permissionProfile: data.activePermissionProfile?.id,
  };
}
