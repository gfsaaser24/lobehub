import {
  TEAM_MEMBER_POLICIES_KEY,
  TEAM_PENDING_INVITE_POLICIES_KEY,
  TEAM_WORKSPACE_NAME,
  TEAM_WORKSPACE_SLUG,
} from '@lobechat/const';
import type { UserModelPolicy } from '@lobechat/types';
import { eq } from 'drizzle-orm';

import { users } from '../schemas/user';
import { workspaceMembers, workspaces } from '../schemas/workspace';
import type { LobeChatDatabase, Transaction } from '../type';

const EFFECTIVE_POLICY_CACHE_TTL_MS = 30 * 1000;

interface EffectivePolicyCacheEntry {
  expiresAt: number;
  policy: UserModelPolicy | null;
}

/**
 * In-process TTL cache for `getEffectivePolicy`. Module-level so every
 * `TeamPolicyModel` instance (they're constructed per-request) shares it.
 * Cache misses cost two queries (users.role + workspaces.settings); hot chat
 * paths hit the cache instead.
 */
const effectivePolicyCache = new Map<string, EffectivePolicyCacheEntry>();

/**
 * Drop the cached effective policy for one user (after a policy write) or for
 * everyone (no args — e.g. after a bulk import).
 */
export const invalidateTeamPolicyCache = (userId?: string) => {
  if (userId) effectivePolicyCache.delete(userId);
  else effectivePolicyCache.clear();
};

/**
 * Team mode (fork feature) — per-user model access policies.
 *
 * Policies live in the singleton team workspace's `workspaces.settings` jsonb
 * (slug `TEAM_WORKSPACE_SLUG`), under fork-namespaced keys — see
 * `@lobechat/types` `UserModelPolicy` for storage layout and semantics. We
 * reuse upstream's workspace tables to avoid fork-own migrations.
 *
 * NOTE: `WorkspaceModel.updateSettings` is a FULL REPLACE of the settings
 * jsonb, so every write here is a read-modify-write merge inside a
 * `SELECT ... FOR UPDATE` transaction — never a blind settings overwrite.
 */
export class TeamPolicyModel {
  private readonly db: LobeChatDatabase;

  constructor(db: LobeChatDatabase) {
    this.db = db;
  }

  /**
   * Find-or-create the singleton team workspace. Safe under concurrent calls:
   * the insert is `ON CONFLICT (slug) DO NOTHING` against the unique slug
   * index, and the loser of the race re-reads the winner's row.
   */
  ensureTeamWorkspace = async (ownerUserId: string): Promise<{ id: string }> => {
    const existing = await this.findTeamWorkspace();
    if (existing) return { id: existing.id };

    return this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(workspaces)
        .values({
          name: TEAM_WORKSPACE_NAME,
          primaryOwnerId: ownerUserId,
          slug: TEAM_WORKSPACE_SLUG,
        })
        .onConflictDoNothing({ target: workspaces.slug })
        .returning({ id: workspaces.id });

      // Lost the race: another caller created the workspace between our check
      // and the insert — reuse theirs.
      if (!created) {
        const winner = await tx.query.workspaces.findFirst({
          columns: { id: true },
          where: eq(workspaces.slug, TEAM_WORKSPACE_SLUG),
        });
        if (!winner) throw new Error('Team workspace insert conflicted but no row exists');
        return { id: winner.id };
      }

      await tx
        .insert(workspaceMembers)
        .values({ role: 'owner', userId: ownerUserId, workspaceId: created.id })
        .onConflictDoNothing();

      return { id: created.id };
    });
  };

  /**
   * Raw stored policy for a user — `null` when the user has no entry (or the
   * team workspace doesn't exist yet). Does NOT apply the admin bypass; use
   * `getEffectivePolicy` for enforcement.
   */
  getPolicyForUser = async (userId: string): Promise<UserModelPolicy | null> => {
    const workspace = await this.findTeamWorkspace();
    if (!workspace) return null;

    const policies = this.readBucket(workspace.settings, TEAM_MEMBER_POLICIES_KEY);
    return policies[userId] ?? null;
  };

  /**
   * Policy to ENFORCE for a user: `null` (unrestricted) when the user is an
   * admin (`users.role === 'admin'`) or has no policy entry. Results are
   * cached in-process for 30s — call `invalidateTeamPolicyCache` after writes.
   */
  getEffectivePolicy = async (userId: string): Promise<UserModelPolicy | null> => {
    const cached = effectivePolicyCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.policy;

    const policy = (await this.isUserAdmin(userId)) ? null : await this.getPolicyForUser(userId);

    effectivePolicyCache.set(userId, {
      expiresAt: Date.now() + EFFECTIVE_POLICY_CACHE_TTL_MS,
      policy,
    });

    return policy;
  };

  /**
   * Set (or clear, with `null`) the stored policy for a user, then invalidate
   * their cached effective policy.
   */
  setPolicyForUser = async (userId: string, policy: UserModelPolicy | null): Promise<void> => {
    await this.writeBucketEntry(TEAM_MEMBER_POLICIES_KEY, userId, policy);
    invalidateTeamPolicyCache(userId);
  };

  /**
   * Stage (or clear, with `null`) the policy chosen at invite time. Staged
   * policies are keyed by invitation id and moved to the member bucket via
   * `takeStagedInvitePolicy` + `setPolicyForUser` on acceptance.
   */
  stageInvitePolicy = async (
    invitationId: string,
    policy: UserModelPolicy | null,
  ): Promise<void> => {
    await this.writeBucketEntry(TEAM_PENDING_INVITE_POLICIES_KEY, invitationId, policy);
  };

  /**
   * Remove and return the staged policy for an invitation — `null` when
   * nothing was staged. "Take" semantics: a second call returns `null`.
   */
  takeStagedInvitePolicy = async (invitationId: string): Promise<UserModelPolicy | null> => {
    return this.db.transaction(async (tx) => {
      const workspace = await this.selectTeamWorkspaceForUpdate(tx);
      if (!workspace) return null;

      const settings = (workspace.settings as Record<string, any> | null) ?? {};
      const staged = { ...this.readBucket(workspace.settings, TEAM_PENDING_INVITE_POLICIES_KEY) };

      const policy = staged[invitationId];
      if (!policy) return null;

      delete staged[invitationId];

      await tx
        .update(workspaces)
        .set({
          settings: { ...settings, [TEAM_PENDING_INVITE_POLICIES_KEY]: staged },
          updatedAt: new Date(),
        })
        .where(eq(workspaces.id, workspace.id));

      return policy;
    });
  };

  isUserAdmin = async (userId: string): Promise<boolean> => {
    const user = await this.db.query.users.findFirst({
      columns: { role: true },
      where: eq(users.id, userId),
    });
    return user?.role === 'admin';
  };

  // ===== internals ===== //

  private findTeamWorkspace = async () => {
    return this.db.query.workspaces.findFirst({
      columns: { id: true, settings: true },
      where: eq(workspaces.slug, TEAM_WORKSPACE_SLUG),
    });
  };

  private selectTeamWorkspaceForUpdate = async (tx: Transaction) => {
    // slug is unique — at most one row. FOR UPDATE serializes concurrent
    // read-modify-write cycles on the settings jsonb.
    const [workspace] = await tx
      .select({ id: workspaces.id, settings: workspaces.settings })
      .from(workspaces)
      .where(eq(workspaces.slug, TEAM_WORKSPACE_SLUG))
      .for('update');
    return workspace;
  };

  private readBucket = (
    settings: unknown,
    bucketKey: string,
  ): Record<string, UserModelPolicy> => {
    const raw = ((settings as Record<string, any> | null) ?? {})[bucketKey];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return raw as Record<string, UserModelPolicy>;
  };

  /**
   * Read-modify-write one entry of a fork-namespaced settings bucket. Merges
   * into the existing settings jsonb under `FOR UPDATE` so concurrent writers
   * (and unrelated settings keys) are never clobbered.
   */
  private writeBucketEntry = async (
    bucketKey: string,
    entryId: string,
    policy: UserModelPolicy | null,
  ): Promise<void> => {
    await this.db.transaction(async (tx) => {
      const workspace = await this.selectTeamWorkspaceForUpdate(tx);

      if (!workspace) {
        // Clearing an entry when the team workspace doesn't exist is a no-op.
        if (policy === null) return;
        throw new Error(
          'Team workspace not found — call ensureTeamWorkspace before writing policies',
        );
      }

      const settings = (workspace.settings as Record<string, any> | null) ?? {};
      const bucket = { ...this.readBucket(workspace.settings, bucketKey) };

      if (policy === null) delete bucket[entryId];
      else bucket[entryId] = policy;

      await tx
        .update(workspaces)
        .set({ settings: { ...settings, [bucketKey]: bucket }, updatedAt: new Date() })
        .where(eq(workspaces.id, workspace.id));
    });
  };
}
