import {
  TEAM_MEMBER_POLICIES_KEY,
  TEAM_PENDING_INVITE_POLICIES_KEY,
  TEAM_WORKSPACE_NAME,
  TEAM_WORKSPACE_SLUG,
} from '@lobechat/const';
import type { UserModelPolicy } from '@lobechat/types';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { users, workspaceMembers, workspaces } from '../../schemas';
import type { LobeChatDatabase } from '../../type';
import { invalidateTeamPolicyCache, TeamPolicyModel } from '../teamPolicy';

const serverDB: LobeChatDatabase = await getTestDB();

const adminId = 'tp-admin';
const memberId = 'tp-member';
const otherMemberId = 'tp-other-member';

const openaiOnly: UserModelPolicy = { allowedProviders: ['openai'] };
const narrowed: UserModelPolicy = {
  allowedModels: { openai: ['gpt-5'] },
  allowedProviders: ['openai'],
};

const model = new TeamPolicyModel(serverDB);

const getTeamWorkspaceRow = async () => {
  const [row] = await serverDB
    .select()
    .from(workspaces)
    .where(eq(workspaces.slug, TEAM_WORKSPACE_SLUG));
  return row;
};

beforeEach(async () => {
  invalidateTeamPolicyCache();
  await serverDB.delete(users);
  await serverDB.insert(users).values([
    { id: adminId, role: 'admin' },
    { id: memberId },
    { id: otherMemberId },
  ]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await serverDB.delete(users);
});

describe('TeamPolicyModel', () => {
  describe('ensureTeamWorkspace', () => {
    it('creates the team workspace with the owner as member', async () => {
      const { id } = await model.ensureTeamWorkspace(adminId);

      const workspace = await getTeamWorkspaceRow();
      expect(workspace.id).toBe(id);
      expect(workspace.name).toBe(TEAM_WORKSPACE_NAME);
      expect(workspace.primaryOwnerId).toBe(adminId);

      const members = await serverDB
        .select()
        .from(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, id));
      expect(members).toHaveLength(1);
      expect(members[0]).toMatchObject({ role: 'owner', userId: adminId });
    });

    it('is idempotent — a second call returns the existing workspace', async () => {
      const first = await model.ensureTeamWorkspace(adminId);
      const second = await model.ensureTeamWorkspace(memberId);

      expect(second.id).toBe(first.id);

      const rows = await serverDB
        .select()
        .from(workspaces)
        .where(eq(workspaces.slug, TEAM_WORKSPACE_SLUG));
      expect(rows).toHaveLength(1);
      // the original owner is kept
      expect(rows[0].primaryOwnerId).toBe(adminId);
    });

    it('recovers when losing the insert race', async () => {
      await serverDB.insert(workspaces).values({
        id: 'tp-race-ws',
        name: TEAM_WORKSPACE_NAME,
        primaryOwnerId: adminId,
        slug: TEAM_WORKSPACE_SLUG,
      });

      // Simulate a concurrent creator winning between the pre-check and the
      // insert: the pre-check sees nothing, the slug insert conflicts, and the
      // loser must re-read the winner's row.
      vi.spyOn(model as any, 'findTeamWorkspace').mockResolvedValueOnce(undefined);

      const result = await model.ensureTeamWorkspace(memberId);
      expect(result.id).toBe('tp-race-ws');
    });
  });

  describe('getPolicyForUser / setPolicyForUser', () => {
    it('returns null when the team workspace does not exist', async () => {
      expect(await model.getPolicyForUser(memberId)).toBeNull();
    });

    it('returns null for a user without a policy entry', async () => {
      await model.ensureTeamWorkspace(adminId);

      expect(await model.getPolicyForUser(memberId)).toBeNull();
    });

    it('round-trips a stored policy', async () => {
      await model.ensureTeamWorkspace(adminId);

      await model.setPolicyForUser(memberId, narrowed);

      expect(await model.getPolicyForUser(memberId)).toEqual(narrowed);
    });

    it('clears the entry when setting null', async () => {
      await model.ensureTeamWorkspace(adminId);
      await model.setPolicyForUser(memberId, openaiOnly);

      await model.setPolicyForUser(memberId, null);

      expect(await model.getPolicyForUser(memberId)).toBeNull();
    });

    it('merges into existing settings instead of replacing them', async () => {
      await serverDB.insert(workspaces).values({
        id: 'tp-settings-ws',
        name: TEAM_WORKSPACE_NAME,
        primaryOwnerId: adminId,
        settings: { keep: true, [TEAM_MEMBER_POLICIES_KEY]: { [otherMemberId]: openaiOnly } },
        slug: TEAM_WORKSPACE_SLUG,
      });

      await model.setPolicyForUser(memberId, narrowed);

      const workspace = await getTeamWorkspaceRow();
      expect(workspace.settings).toEqual({
        keep: true,
        [TEAM_MEMBER_POLICIES_KEY]: { [memberId]: narrowed, [otherMemberId]: openaiOnly },
      });
    });

    it('setting null without a team workspace is a no-op', async () => {
      await expect(model.setPolicyForUser(memberId, null)).resolves.toBeUndefined();
    });

    it('setting a policy without a team workspace throws', async () => {
      await expect(model.setPolicyForUser(memberId, openaiOnly)).rejects.toThrow(
        /Team workspace not found/,
      );
    });
  });

  describe('getEffectivePolicy', () => {
    it('returns null for a user without a policy entry', async () => {
      await model.ensureTeamWorkspace(adminId);

      expect(await model.getEffectivePolicy(memberId)).toBeNull();
    });

    it('returns the stored policy for a restricted non-admin user', async () => {
      await model.ensureTeamWorkspace(adminId);
      await model.setPolicyForUser(memberId, openaiOnly);

      expect(await model.getEffectivePolicy(memberId)).toEqual(openaiOnly);
    });

    it('bypasses the policy for admins (users.role === "admin")', async () => {
      await model.ensureTeamWorkspace(adminId);
      await model.setPolicyForUser(adminId, openaiOnly);

      expect(await model.getEffectivePolicy(adminId)).toBeNull();
      // the raw entry is still stored — only enforcement is bypassed
      expect(await model.getPolicyForUser(adminId)).toEqual(openaiOnly);
    });

    it('caches results within the TTL', async () => {
      await model.ensureTeamWorkspace(adminId);
      await model.setPolicyForUser(memberId, openaiOnly);
      expect(await model.getEffectivePolicy(memberId)).toEqual(openaiOnly);

      // mutate the DB behind the cache's back
      await serverDB
        .update(workspaces)
        .set({ settings: { [TEAM_MEMBER_POLICIES_KEY]: {} } })
        .where(eq(workspaces.slug, TEAM_WORKSPACE_SLUG));

      // still served from cache
      expect(await model.getEffectivePolicy(memberId)).toEqual(openaiOnly);
    });

    it('expires cache entries after the TTL', async () => {
      await model.ensureTeamWorkspace(adminId);
      await model.setPolicyForUser(memberId, openaiOnly);

      const realNow = Date.now();
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow);
      expect(await model.getEffectivePolicy(memberId)).toEqual(openaiOnly);

      // mutate the DB behind the cache's back
      await serverDB
        .update(workspaces)
        .set({ settings: { [TEAM_MEMBER_POLICIES_KEY]: {} } })
        .where(eq(workspaces.slug, TEAM_WORKSPACE_SLUG));

      nowSpy.mockReturnValue(realNow + 31_000);

      expect(await model.getEffectivePolicy(memberId)).toBeNull();
    });

    it('setPolicyForUser invalidates the cached entry', async () => {
      await model.ensureTeamWorkspace(adminId);
      await model.setPolicyForUser(memberId, openaiOnly);
      expect(await model.getEffectivePolicy(memberId)).toEqual(openaiOnly);

      await model.setPolicyForUser(memberId, narrowed);

      expect(await model.getEffectivePolicy(memberId)).toEqual(narrowed);
    });

    it('invalidateTeamPolicyCache(userId) only drops that user', async () => {
      await model.ensureTeamWorkspace(adminId);
      await model.setPolicyForUser(memberId, openaiOnly);
      await model.setPolicyForUser(otherMemberId, openaiOnly);
      await model.getEffectivePolicy(memberId);
      await model.getEffectivePolicy(otherMemberId);

      // mutate both entries behind the cache's back
      await serverDB
        .update(workspaces)
        .set({ settings: { [TEAM_MEMBER_POLICIES_KEY]: {} } })
        .where(eq(workspaces.slug, TEAM_WORKSPACE_SLUG));

      invalidateTeamPolicyCache(memberId);

      expect(await model.getEffectivePolicy(memberId)).toBeNull();
      expect(await model.getEffectivePolicy(otherMemberId)).toEqual(openaiOnly);
    });

    it('invalidateTeamPolicyCache() drops every user', async () => {
      await model.ensureTeamWorkspace(adminId);
      await model.setPolicyForUser(memberId, openaiOnly);
      await model.getEffectivePolicy(memberId);

      await serverDB
        .update(workspaces)
        .set({ settings: { [TEAM_MEMBER_POLICIES_KEY]: {} } })
        .where(eq(workspaces.slug, TEAM_WORKSPACE_SLUG));

      invalidateTeamPolicyCache();

      expect(await model.getEffectivePolicy(memberId)).toBeNull();
    });
  });

  describe('stageInvitePolicy / takeStagedInvitePolicy', () => {
    it('takes a staged policy exactly once', async () => {
      await model.ensureTeamWorkspace(adminId);
      await model.stageInvitePolicy('invite-1', narrowed);

      expect(await model.takeStagedInvitePolicy('invite-1')).toEqual(narrowed);
      // "take" semantics — the entry is gone
      expect(await model.takeStagedInvitePolicy('invite-1')).toBeNull();
    });

    it('returns null when nothing was staged', async () => {
      await model.ensureTeamWorkspace(adminId);

      expect(await model.takeStagedInvitePolicy('invite-unknown')).toBeNull();
    });

    it('returns null when the team workspace does not exist', async () => {
      expect(await model.takeStagedInvitePolicy('invite-1')).toBeNull();
    });

    it('staging null clears a previously staged policy', async () => {
      await model.ensureTeamWorkspace(adminId);
      await model.stageInvitePolicy('invite-1', openaiOnly);

      await model.stageInvitePolicy('invite-1', null);

      expect(await model.takeStagedInvitePolicy('invite-1')).toBeNull();
    });

    it('keeps staged and member buckets independent', async () => {
      await model.ensureTeamWorkspace(adminId);
      await model.setPolicyForUser(memberId, openaiOnly);
      await model.stageInvitePolicy('invite-1', narrowed);

      const workspace = await getTeamWorkspaceRow();
      expect(workspace.settings).toMatchObject({
        [TEAM_MEMBER_POLICIES_KEY]: { [memberId]: openaiOnly },
        [TEAM_PENDING_INVITE_POLICIES_KEY]: { 'invite-1': narrowed },
      });

      // taking the staged policy must not touch member policies
      await model.takeStagedInvitePolicy('invite-1');
      expect(await model.getPolicyForUser(memberId)).toEqual(openaiOnly);
    });
  });

  describe('isUserAdmin', () => {
    it('returns true only for users.role === "admin"', async () => {
      expect(await model.isUserAdmin(adminId)).toBe(true);
      expect(await model.isUserAdmin(memberId)).toBe(false);
      expect(await model.isUserAdmin('nobody')).toBe(false);
    });
  });
});
