// @vitest-environment node
import { TEAM_MEMBER_POLICIES_KEY, TEAM_PENDING_INVITE_POLICIES_KEY } from '@lobechat/const';
import type { UserModelPolicy } from '@lobechat/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getServerDB } from '@/database/core/db-adaptor';
import { TeamPolicyModel, invalidateTeamPolicyCache } from '@/database/models/teamPolicy';
import { WorkspaceMemberModel } from '@/database/models/workspaceMember';
import { users } from '@/database/schemas';

import { teamRouter } from '../team';

// suspendUser revokes sessions through better-auth's internal adapter (clears
// Redis secondaryStorage AND the DB fallback) — mock the auth instance.
const { deleteUserSessionsMock } = vi.hoisted(() => ({ deleteUserSessionsMock: vi.fn() }));

vi.mock('@/auth', () => ({
  auth: {
    $context: Promise.resolve({ internalAdapter: { deleteUserSessions: deleteUserSessionsMock } }),
  },
}));

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(),
}));

vi.mock('@/database/models/teamPolicy', () => ({
  TeamPolicyModel: vi.fn(),
  invalidateTeamPolicyCache: vi.fn(),
}));

vi.mock('@/database/models/workspaceMember', () => ({
  WorkspaceMemberModel: vi.fn(),
}));

vi.mock('@/envs/app', () => ({
  appEnv: { APP_URL: 'https://chat.example.test' },
}));

const adminUserId = 'admin-user';
const memberUserId = 'member-user';
const teamWorkspaceId = 'ws-team';

const samplePolicy: UserModelPolicy = {
  allowedModels: { openai: ['gpt-4o'] },
  allowedProviders: ['openai'],
};

const createDBMock = () => {
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn(() => ({ where: updateWhere }));

  return {
    db: {
      query: {
        users: { findFirst: vi.fn() },
        workspaces: { findFirst: vi.fn() },
      },
      select: vi.fn(),
      update: vi.fn(() => ({ set: updateSet })),
    },
    updateSet,
    updateWhere,
  };
};

let db: any;
let updateSet: ReturnType<typeof vi.fn>;
let teamPolicyModel: {
  ensureTeamWorkspace: ReturnType<typeof vi.fn>;
  setPolicyForUser: ReturnType<typeof vi.fn>;
  stageInvitePolicy: ReturnType<typeof vi.fn>;
};
let workspaceMemberModel: {
  createInvitation: ReturnType<typeof vi.fn>;
  listPendingInvitations: ReturnType<typeof vi.fn>;
  updateInvitationStatus: ReturnType<typeof vi.fn>;
};

const mockSelectRows = (rows: unknown[]) => {
  const chain: any = {
    from: vi.fn(() => chain),
    leftJoin: vi.fn(() => chain),
    orderBy: vi.fn().mockResolvedValue(rows),
  };
  db.select = vi.fn(() => chain);
  return chain;
};

const createCaller = (userId: string = adminUserId) => teamRouter.createCaller({ userId } as any);

beforeEach(() => {
  vi.clearAllMocks();

  const mock = createDBMock();
  db = mock.db;
  updateSet = mock.updateSet;

  // admin gate passes by default; individual tests override
  db.query.users.findFirst.mockResolvedValue({ role: 'admin' });

  teamPolicyModel = {
    ensureTeamWorkspace: vi.fn().mockResolvedValue({ id: teamWorkspaceId }),
    setPolicyForUser: vi.fn().mockResolvedValue(undefined),
    stageInvitePolicy: vi.fn().mockResolvedValue(undefined),
  };
  vi.mocked(TeamPolicyModel).mockImplementation(() => teamPolicyModel as any);

  workspaceMemberModel = {
    createInvitation: vi.fn(),
    listPendingInvitations: vi.fn().mockResolvedValue([]),
    updateInvitationStatus: vi.fn().mockResolvedValue(undefined),
  };
  vi.mocked(WorkspaceMemberModel).mockImplementation(() => workspaceMemberModel as any);

  vi.mocked(getServerDB).mockResolvedValue(db as any);
});

describe('teamRouter', () => {
  describe('getTeamContext', () => {
    it('returns isAdmin true for admin users and nothing else', async () => {
      db.query.users.findFirst.mockResolvedValue({ role: 'admin' });

      const result = await createCaller().getTeamContext();

      expect(result).toEqual({ isAdmin: true });
    });

    it('returns isAdmin false for non-admin users', async () => {
      db.query.users.findFirst.mockResolvedValue({ role: null });

      const result = await createCaller(memberUserId).getTeamContext();

      expect(result).toEqual({ isAdmin: false });
    });
  });

  describe('admin gate', () => {
    it('rejects non-admin callers with FORBIDDEN', async () => {
      db.query.users.findFirst.mockResolvedValue({ role: null });

      await expect(createCaller(memberUserId).listMembers()).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'ADMIN_ONLY',
      });
    });

    it('rejects unknown users with FORBIDDEN', async () => {
      db.query.users.findFirst.mockResolvedValue(undefined);

      await expect(
        createCaller('ghost-user').suspendUser({ userId: memberUserId }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  describe('listMembers', () => {
    it('lists all users with team membership and policies merged in', async () => {
      const joinedAt = new Date('2026-05-01T10:00:00Z');
      const banExpires = new Date('2026-08-01T00:00:00Z');

      db.query.workspaces.findFirst.mockResolvedValue({
        id: teamWorkspaceId,
        settings: { [TEAM_MEMBER_POLICIES_KEY]: { [memberUserId]: samplePolicy } },
      });

      const chain = mockSelectRows([
        {
          avatar: null,
          banExpires: null,
          banReason: null,
          banned: false,
          email: 'admin@example.com',
          fullName: 'Admin',
          id: adminUserId,
          joinedTeamAt: null,
          role: 'admin',
          username: 'admin',
        },
        {
          avatar: 'https://cdn.example.com/a.png',
          banExpires,
          banReason: 'spam',
          banned: true,
          email: 'member@example.com',
          fullName: 'Member',
          id: memberUserId,
          joinedTeamAt: joinedAt,
          role: null,
          username: 'member',
        },
      ]);

      const result = await createCaller().listMembers();

      expect(chain.leftJoin).toHaveBeenCalled();
      expect(result).toEqual([
        {
          avatar: null,
          banExpires: null,
          banReason: null,
          banned: false,
          email: 'admin@example.com',
          fullName: 'Admin',
          id: adminUserId,
          isAdmin: true,
          joinedTeamAt: null,
          policy: null,
          username: 'admin',
        },
        {
          avatar: 'https://cdn.example.com/a.png',
          banExpires: banExpires.toISOString(),
          banReason: 'spam',
          banned: true,
          email: 'member@example.com',
          fullName: 'Member',
          id: memberUserId,
          isAdmin: false,
          joinedTeamAt: joinedAt.toISOString(),
          policy: samplePolicy,
          username: 'member',
        },
      ]);
    });

    it('still lists users when the team workspace does not exist yet', async () => {
      db.query.workspaces.findFirst.mockResolvedValue(undefined);

      mockSelectRows([
        {
          avatar: null,
          banExpires: null,
          banReason: null,
          banned: null,
          email: 'admin@example.com',
          fullName: null,
          id: adminUserId,
          role: 'admin',
          username: null,
        },
      ]);

      const result = await createCaller().listMembers();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        banned: false,
        id: adminUserId,
        isAdmin: true,
        joinedTeamAt: null,
        policy: null,
      });
    });
  });

  describe('listInvites', () => {
    it('returns an empty list when no team workspace exists', async () => {
      db.query.workspaces.findFirst.mockResolvedValue(undefined);

      const result = await createCaller().listInvites();

      expect(result).toEqual([]);
      expect(workspaceMemberModel.listPendingInvitations).not.toHaveBeenCalled();
    });

    it('returns pending invites with links and marks stale ones expired', async () => {
      const createdAt = new Date('2026-06-01T00:00:00Z');
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const past = new Date(Date.now() - 24 * 60 * 60 * 1000);

      db.query.workspaces.findFirst.mockResolvedValue({
        id: teamWorkspaceId,
        settings: { [TEAM_PENDING_INVITE_POLICIES_KEY]: { 'inv-live': samplePolicy } },
      });

      workspaceMemberModel.listPendingInvitations.mockResolvedValue([
        {
          createdAt,
          email: 'fresh@example.com',
          expiresAt: future,
          id: 'inv-live',
          role: 'member',
          status: 'pending',
          token: 'tok_live',
        },
        {
          createdAt,
          email: 'stale@example.com',
          expiresAt: past,
          id: 'inv-stale',
          role: 'viewer',
          status: 'pending',
          token: 'tok_stale',
        },
      ]);

      const result = await createCaller().listInvites();

      expect(workspaceMemberModel.updateInvitationStatus).toHaveBeenCalledWith(
        'inv-stale',
        'expired',
      );
      // stale invites also release their staged policy (mirrors revokeInvite)
      expect(teamPolicyModel.stageInvitePolicy).toHaveBeenCalledWith('inv-stale', null);
      expect(teamPolicyModel.stageInvitePolicy).not.toHaveBeenCalledWith('inv-live', null);
      expect(result).toEqual([
        {
          createdAt: createdAt.toISOString(),
          email: 'fresh@example.com',
          expiresAt: future.toISOString(),
          id: 'inv-live',
          link: 'https://chat.example.test/join/tok_live',
          policy: samplePolicy,
          role: 'member',
          status: 'pending',
        },
      ]);
    });
  });

  describe('createInvite', () => {
    const invitationRow = {
      createdAt: new Date('2026-06-15T00:00:00Z'),
      email: 'new@example.com',
      expiresAt: new Date('2026-06-22T00:00:00Z'),
      id: 'inv-new',
      role: 'member',
      status: 'pending',
      token: 'tok_new',
    };

    it('rejects emails that already belong to a user with EMAIL_EXISTS', async () => {
      db.query.users.findFirst
        .mockResolvedValueOnce({ role: 'admin' }) // admin gate
        .mockResolvedValueOnce({ id: 'existing-user' }); // email lookup

      await expect(createCaller().createInvite({ email: 'taken@example.com' })).rejects.toMatchObject(
        { code: 'CONFLICT', message: 'EMAIL_EXISTS' },
      );
      expect(workspaceMemberModel.createInvitation).not.toHaveBeenCalled();
    });

    it('rejects emails with a pending unexpired invite with INVITE_EXISTS', async () => {
      db.query.users.findFirst
        .mockResolvedValueOnce({ role: 'admin' })
        .mockResolvedValueOnce(undefined);

      workspaceMemberModel.listPendingInvitations.mockResolvedValue([
        {
          ...invitationRow,
          email: 'new@example.com',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      ]);

      await expect(createCaller().createInvite({ email: 'New@Example.com' })).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'INVITE_EXISTS',
      });
      expect(workspaceMemberModel.createInvitation).not.toHaveBeenCalled();
    });

    it('creates the invitation, stages the policy and returns the link', async () => {
      db.query.users.findFirst
        .mockResolvedValueOnce({ role: 'admin' })
        .mockResolvedValueOnce(undefined);

      workspaceMemberModel.createInvitation.mockResolvedValue(invitationRow);

      const result = await createCaller().createInvite({
        email: 'New@Example.COM',
        policy: samplePolicy,
        role: 'viewer',
      });

      expect(teamPolicyModel.ensureTeamWorkspace).toHaveBeenCalledWith(adminUserId);
      expect(workspaceMemberModel.createInvitation).toHaveBeenCalledWith({
        email: 'new@example.com',
        role: 'viewer',
        workspaceId: teamWorkspaceId,
      });
      expect(teamPolicyModel.stageInvitePolicy).toHaveBeenCalledWith('inv-new', samplePolicy);
      expect(result.link).toBe('https://chat.example.test/join/tok_new');
      expect(result.invite).toEqual({
        createdAt: invitationRow.createdAt.toISOString(),
        email: 'new@example.com',
        expiresAt: invitationRow.expiresAt.toISOString(),
        id: 'inv-new',
        link: 'https://chat.example.test/join/tok_new',
        policy: samplePolicy,
        role: 'member',
        status: 'pending',
      });
    });

    it('stages a null policy when none is provided', async () => {
      db.query.users.findFirst
        .mockResolvedValueOnce({ role: 'admin' })
        .mockResolvedValueOnce(undefined);

      workspaceMemberModel.createInvitation.mockResolvedValue(invitationRow);

      await createCaller().createInvite({ email: 'new@example.com' });

      expect(workspaceMemberModel.createInvitation).toHaveBeenCalledWith({
        email: 'new@example.com',
        role: 'member',
        workspaceId: teamWorkspaceId,
      });
      expect(teamPolicyModel.stageInvitePolicy).toHaveBeenCalledWith('inv-new', null);
    });
  });

  describe('revokeInvite', () => {
    it('revokes the invitation and clears the staged policy', async () => {
      const result = await createCaller().revokeInvite({ id: 'inv-1' });

      expect(workspaceMemberModel.updateInvitationStatus).toHaveBeenCalledWith('inv-1', 'revoked');
      expect(teamPolicyModel.stageInvitePolicy).toHaveBeenCalledWith('inv-1', null);
      expect(result).toEqual({ success: true });
    });
  });

  describe('setUserPolicy', () => {
    it('persists the policy and invalidates the cache for that user', async () => {
      const result = await createCaller().setUserPolicy({
        policy: samplePolicy,
        userId: memberUserId,
      });

      expect(teamPolicyModel.setPolicyForUser).toHaveBeenCalledWith(memberUserId, samplePolicy);
      expect(vi.mocked(invalidateTeamPolicyCache)).toHaveBeenCalledWith(memberUserId);
      expect(result).toEqual({ success: true });
    });

    it('ensures the team workspace exists before the first invite is ever created', async () => {
      await createCaller().setUserPolicy({ policy: samplePolicy, userId: memberUserId });

      expect(teamPolicyModel.ensureTeamWorkspace).toHaveBeenCalledWith(adminUserId);
      // find-or-create runs BEFORE the policy write so the write never throws
      // 'Team workspace not found'
      expect(teamPolicyModel.ensureTeamWorkspace.mock.invocationCallOrder[0]).toBeLessThan(
        teamPolicyModel.setPolicyForUser.mock.invocationCallOrder[0],
      );
    });

    it('accepts null to clear a policy', async () => {
      await createCaller().setUserPolicy({ policy: null, userId: memberUserId });

      expect(teamPolicyModel.setPolicyForUser).toHaveBeenCalledWith(memberUserId, null);
    });
  });

  describe('suspendUser', () => {
    it('refuses to suspend the caller themselves', async () => {
      await expect(createCaller().suspendUser({ userId: adminUserId })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'CANNOT_SUSPEND_SELF',
      });
      expect(db.update).not.toHaveBeenCalled();
    });

    it('bans the user, revokes their better-auth sessions and invalidates the policy cache', async () => {
      const result = await createCaller().suspendUser({
        reason: 'policy violation',
        userId: memberUserId,
      });

      expect(db.update).toHaveBeenCalledWith(users);
      expect(updateSet).toHaveBeenCalledWith({ banReason: 'policy violation', banned: true });
      // revocation goes through better-auth's internal adapter so the Redis
      // secondaryStorage entries are cleared too, not just the DB fallback rows
      expect(deleteUserSessionsMock).toHaveBeenCalledWith(memberUserId);
      expect(vi.mocked(invalidateTeamPolicyCache)).toHaveBeenCalledWith(memberUserId);
      expect(result).toEqual({ success: true });
    });

    it('stores a null reason when none is provided', async () => {
      await createCaller().suspendUser({ userId: memberUserId });

      expect(updateSet).toHaveBeenCalledWith({ banReason: null, banned: true });
    });
  });

  describe('restoreUser', () => {
    it('clears the ban fields', async () => {
      const result = await createCaller().restoreUser({ userId: memberUserId });

      expect(db.update).toHaveBeenCalledWith(users);
      expect(updateSet).toHaveBeenCalledWith({ banExpires: null, banReason: null, banned: false });
      expect(result).toEqual({ success: true });
    });
  });
});
