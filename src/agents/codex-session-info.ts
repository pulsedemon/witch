import { z } from 'zod';
import type { SessionInfo } from './types.js';

const activePermissionProfile = z.object({ id: z.string() }).nullish();

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
