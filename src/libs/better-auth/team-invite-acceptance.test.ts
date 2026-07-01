// @vitest-environment node
import type { UserModelPolicy } from '@lobechat/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TeamPolicyModel } from '@/database/models/teamPolicy';
import { WorkspaceMemberModel } from '@/database/models/workspaceMember';

import { acceptTeamInviteForNewUser } from './team-invite-acceptance';

// Mirror the `serverDB.select().from().where()` chain used to find invitations.
const dbMocks = vi.hoisted(() => {
  const where = vi.fn<() => Promise<any[]>>(async () => []);
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));

  return { from, select, where };
});

const memberModelMocks = vi.hoisted(() => ({
  addMember: vi.fn(),
  updateInvitationStatus: vi.fn(),
}));

const policyModelMocks = vi.hoisted(() => ({
  moveStagedInvitePolicyToUser: vi.fn(),
}));

vi.mock('@lobechat/database', () => ({
  serverDB: { select: dbMocks.select },
}));

vi.mock('@/database/models/workspaceMember', () => ({
  WorkspaceMemberModel: vi.fn(() => memberModelMocks),
}));

vi.mock('@/database/models/teamPolicy', () => ({
  TeamPolicyModel: vi.fn(() => policyModelMocks),
}));

const buildInvitation = (overrides: Record<string, unknown> = {}) => ({
  email: 'invited@other.com',
  expiresAt: new Date(Date.now() + 86_400_000),
  id: 'inv_1',
  inviterId: 'user_admin',
  role: 'member',
  status: 'pending',
  token: 'token_1',
  workspaceId: 'ws_team',
  ...overrides,
});

describe('acceptTeamInviteForNewUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore the select chain wiring cleared by clearAllMocks
    dbMocks.select.mockReturnValue({ from: dbMocks.from } as any);
    dbMocks.from.mockReturnValue({ where: dbMocks.where } as any);
    dbMocks.where.mockResolvedValue([]);
    policyModelMocks.moveStagedInvitePolicyToUser.mockResolvedValue(null);
  });

  it('should accept a pending invitation and move the staged policy', async () => {
    const policy: UserModelPolicy = { allowedProviders: ['openai'] };
    dbMocks.where.mockResolvedValue([buildInvitation()]);
    policyModelMocks.moveStagedInvitePolicyToUser.mockResolvedValue(policy);

    await acceptTeamInviteForNewUser({ email: 'Invited@Other.com', id: 'user_new' });

    expect(WorkspaceMemberModel).toHaveBeenCalledWith({ select: dbMocks.select }, 'user_new');
    expect(TeamPolicyModel).toHaveBeenCalledWith({ select: dbMocks.select });
    expect(policyModelMocks.moveStagedInvitePolicyToUser).toHaveBeenCalledWith(
      'inv_1',
      'user_new',
    );
    expect(memberModelMocks.addMember).toHaveBeenCalledWith({
      role: 'member',
      userId: 'user_new',
      workspaceId: 'ws_team',
    });
    expect(memberModelMocks.updateInvitationStatus).toHaveBeenCalledWith('inv_1', 'accepted');
  });

  it('should still add the member when no policy was staged (move returns null)', async () => {
    dbMocks.where.mockResolvedValue([buildInvitation()]);
    policyModelMocks.moveStagedInvitePolicyToUser.mockResolvedValue(null);

    await acceptTeamInviteForNewUser({ email: 'invited@other.com', id: 'user_new' });

    expect(memberModelMocks.addMember).toHaveBeenCalledTimes(1);
    expect(memberModelMocks.updateInvitationStatus).toHaveBeenCalledWith('inv_1', 'accepted');
  });

  it('should move the policy BEFORE adding the member, so a later failure cannot leave the user unrestricted', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const policy: UserModelPolicy = { allowedProviders: ['openai'] };
    dbMocks.where.mockResolvedValue([buildInvitation()]);
    policyModelMocks.moveStagedInvitePolicyToUser.mockResolvedValue(policy);
    memberModelMocks.addMember.mockRejectedValueOnce(new Error('insert failed'));

    await expect(
      acceptTeamInviteForNewUser({ email: 'invited@other.com', id: 'user_new' }),
    ).resolves.toBeUndefined();

    // The atomic policy move already completed before the member insert was
    // even attempted — there is no window where the user exists as a member
    // without their policy in force.
    expect(policyModelMocks.moveStagedInvitePolicyToUser).toHaveBeenCalledTimes(1);
    const moveOrder = policyModelMocks.moveStagedInvitePolicyToUser.mock.invocationCallOrder[0];
    const addOrder = memberModelMocks.addMember.mock.invocationCallOrder[0];
    expect(moveOrder).toBeLessThan(addOrder);

    // The invitation stays pending (retryable) — never marked accepted early
    expect(memberModelMocks.updateInvitationStatus).not.toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it('should never add the member when the policy move itself fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    dbMocks.where.mockResolvedValue([buildInvitation()]);
    policyModelMocks.moveStagedInvitePolicyToUser.mockRejectedValueOnce(new Error('tx failed'));

    await expect(
      acceptTeamInviteForNewUser({ email: 'invited@other.com', id: 'user_new' }),
    ).resolves.toBeUndefined();

    // Fail-closed: no membership without the staged policy applied, and the
    // invitation stays pending so acceptance can be retried.
    expect(memberModelMocks.addMember).not.toHaveBeenCalled();
    expect(memberModelMocks.updateInvitationStatus).not.toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it('should be a no-op when no pending invitation matches', async () => {
    dbMocks.where.mockResolvedValue([]);

    await acceptTeamInviteForNewUser({ email: 'stranger@other.com', id: 'user_new' });

    expect(WorkspaceMemberModel).not.toHaveBeenCalled();
    expect(TeamPolicyModel).not.toHaveBeenCalled();
    expect(memberModelMocks.addMember).not.toHaveBeenCalled();
  });

  it('should be a no-op for users without an email', async () => {
    await acceptTeamInviteForNewUser({ email: null, id: 'user_new' });

    expect(dbMocks.select).not.toHaveBeenCalled();
  });

  it('should never throw when the invitation query fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    dbMocks.where.mockRejectedValue(new Error('db down'));

    await expect(
      acceptTeamInviteForNewUser({ email: 'invited@other.com', id: 'user_new' }),
    ).resolves.toBeUndefined();

    consoleError.mockRestore();
  });

  it('should continue with remaining invitations when one fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    dbMocks.where.mockResolvedValue([
      buildInvitation(),
      buildInvitation({ id: 'inv_2', token: 'token_2' }),
    ]);
    memberModelMocks.addMember.mockRejectedValueOnce(new Error('insert failed'));

    await expect(
      acceptTeamInviteForNewUser({ email: 'invited@other.com', id: 'user_new' }),
    ).resolves.toBeUndefined();

    // First invitation failed before status update; second completed fully
    expect(memberModelMocks.updateInvitationStatus).toHaveBeenCalledTimes(1);
    expect(memberModelMocks.updateInvitationStatus).toHaveBeenCalledWith('inv_2', 'accepted');

    consoleError.mockRestore();
  });
});
