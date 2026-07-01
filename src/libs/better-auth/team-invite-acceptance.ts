import { serverDB } from '@lobechat/database';
import { and, eq, gt, sql } from 'drizzle-orm';

import { TeamPolicyModel } from '@/database/models/teamPolicy';
import { WorkspaceMemberModel } from '@/database/models/workspaceMember';
import { workspaceInvitations } from '@/database/schemas/workspace';

interface NewUser {
  email?: string | null;
  id: string;
}

/**
 * Team mode (fork): accept any pending, unexpired team invitation matching a
 * freshly created user's email (case-insensitive).
 *
 * Called from the better-auth `user.create.after` database hook (see
 * define-config.ts). It is deliberately total: every failure is swallowed and
 * logged so signup can never fail because of invite bookkeeping. It is also
 * idempotent — `addMember` upserts on (workspaceId, userId),
 * `updateInvitationStatus` is a plain update, and `takeStagedInvitePolicy`
 * returns null once the staged policy has been consumed.
 *
 * Per-invitation order matters: the staged policy is applied FIRST so that a
 * partial failure can never leave a member with more model access than the
 * admin intended (no policy entry means unrestricted); the invitation is only
 * marked accepted LAST, so a mid-way crash leaves it pending and retryable.
 */
export const acceptTeamInviteForNewUser = async (user: NewUser): Promise<void> => {
  try {
    if (!user.email) return;

    const invitations = await serverDB
      .select()
      .from(workspaceInvitations)
      .where(
        and(
          sql`lower(${workspaceInvitations.email}) = ${user.email.toLowerCase()}`,
          eq(workspaceInvitations.status, 'pending'),
          gt(workspaceInvitations.expiresAt, new Date()),
        ),
      );

    if (invitations.length === 0) return;

    const memberModel = new WorkspaceMemberModel(serverDB, user.id);
    const policyModel = new TeamPolicyModel(serverDB);

    for (const invitation of invitations) {
      try {
        const policy = await policyModel.takeStagedInvitePolicy(invitation.id);
        if (policy) await policyModel.setPolicyForUser(user.id, policy);

        await memberModel.addMember({
          role: invitation.role as 'member' | 'owner' | 'viewer',
          userId: user.id,
          workspaceId: invitation.workspaceId,
        });
        await memberModel.updateInvitationStatus(invitation.id, 'accepted');
      } catch (error) {
        console.error(`[team-invite] failed to accept invitation ${invitation.id}:`, error);
      }
    }
  } catch (error) {
    console.error('[team-invite] failed to process team invitations for new user:', error);
  }
};
