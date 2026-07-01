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
  setPolicyForUser: vi.fn(),
  takeStagedInvitePolicy: vi.fn(),
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
    policyModelMocks.takeStagedInvitePolicy.mockResolvedValue(null);
  });

  it('should accept a pending invitation and move the staged policy', async () => {
    const policy: UserModelPolicy = { allowedProviders: ['openai'] };
    dbMocks.where.mockResolvedValue([buildInvitation()]);
    policyModelMocks.takeStagedInvitePolicy.mockResolvedValue(policy);

    await acceptTeamInviteForNewUser({ email: 'Invited@Other.com', id: 'user_new' });

    expect(WorkspaceMemberModel).toHaveBeenCalledWith({ select: dbMocks.select }, 'user_new');
    expect(TeamPolicyModel).toHaveBeenCalledWith({ select: dbMocks.select });
    expect(policyModelMocks.takeStagedInvitePolicy).toHaveBeenCalledWith('inv_1');
    expect(policyModelMocks.setPolicyForUser).toHaveBeenCalledWith('user_new', policy);
    expect(memberModelMocks.addMember).toHaveBeenCalledWith({
      role: 'member',
      userId: 'user_new',
      workspaceId: 'ws_team',
    });
    expect(memberModelMocks.updateInvitationStatus).toHaveBeenCalledWith('inv_1', 'accepted');
  });

  it('should skip setPolicyForUser when no policy was staged', async () => {
    dbMocks.where.mockResolvedValue([buildInvitation()]);
    policyModelMocks.takeStagedInvitePolicy.mockResolvedValue(null);

    await acceptTeamInviteForNewUser({ email: 'invited@other.com', id: 'user_new' });

    expect(policyModelMocks.setPolicyForUser).not.toHaveBeenCalled();
    expect(memberModelMocks.addMember).toHaveBeenCalledTimes(1);
    expect(memberModelMocks.updateInvitationStatus).toHaveBeenCalledWith('inv_1', 'accepted');
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
