import {
  TEAM_INVITE_PATH,
  TEAM_MEMBER_POLICIES_KEY,
  TEAM_PENDING_INVITE_POLICIES_KEY,
  TEAM_WORKSPACE_SLUG,
} from '@lobechat/const';
import type { TeamInviteDisplay, TeamMemberDisplay, UserModelPolicy } from '@lobechat/types';
import { TRPCError } from '@trpc/server';
import { and, eq, isNull, or } from 'drizzle-orm';
import urlJoin from 'url-join';
import { z } from 'zod';

import { TeamPolicyModel, invalidateTeamPolicyCache } from '@/database/models/teamPolicy';
import { WorkspaceMemberModel } from '@/database/models/workspaceMember';
import { session, users, workspaceMembers, workspaces } from '@/database/schemas';
import { appEnv } from '@/envs/app';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

const userModelPolicySchema = z.object({
  allowedModels: z.record(z.string(), z.union([z.literal('all'), z.array(z.string())])).optional(),
  allowedProviders: z.union([z.literal('all'), z.array(z.string())]),
});

const buildInviteLink = (token: string) => urlJoin(appEnv.APP_URL, TEAM_INVITE_PATH, token);

const teamProcedure = authedProcedure.use(serverDatabase).use(async (opts) => {
  const { ctx } = opts;

  return opts.next({
    ctx: {
      teamPolicyModel: new TeamPolicyModel(ctx.serverDB),
      workspaceMemberModel: new WorkspaceMemberModel(ctx.serverDB, ctx.userId),
    },
  });
});

/**
 * Fork-owned admin gate (team mode). Reads the caller's `users.role` per request and
 * rejects unless it is exactly `admin`. Lives in this file on purpose so upstream
 * middleware files stay untouched across syncs.
 */
const adminProcedure = teamProcedure.use(async (opts) => {
  const { ctx } = opts;

  const caller = await ctx.serverDB.query.users.findFirst({
    columns: { role: true },
    where: eq(users.id, ctx.userId),
  });

  if (caller?.role !== 'admin') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'ADMIN_ONLY' });
  }

  return opts.next();
});

export const teamRouter = router({
  createInvite: adminProcedure
    .input(
      z.object({
        email: z.string().email(),
        policy: userModelPolicySchema.nullish(),
        role: z.enum(['member', 'viewer']).optional(),
      }),
    )
    .mutation(
      async ({ ctx, input }): Promise<{ invite: TeamInviteDisplay; link: string }> => {
        const email = input.email.toLowerCase();

        const existingUser = await ctx.serverDB.query.users.findFirst({
          columns: { id: true },
          where: or(eq(users.email, email), eq(users.normalizedEmail, email)),
        });
        if (existingUser) throw new TRPCError({ code: 'CONFLICT', message: 'EMAIL_EXISTS' });

        const teamWorkspace = await ctx.teamPolicyModel.ensureTeamWorkspace(ctx.userId);

        const now = new Date();
        const pendingInvitations = await ctx.workspaceMemberModel.listPendingInvitations(
          teamWorkspace.id,
        );
        const hasActiveInvite = pendingInvitations.some(
          (invitation) => invitation.email?.toLowerCase() === email && invitation.expiresAt > now,
        );
        if (hasActiveInvite) throw new TRPCError({ code: 'CONFLICT', message: 'INVITE_EXISTS' });

        const invitation = await ctx.workspaceMemberModel.createInvitation({
          email,
          role: input.role ?? 'member',
          workspaceId: teamWorkspace.id,
        });

        await ctx.teamPolicyModel.stageInvitePolicy(invitation.id, input.policy ?? null);

        const link = buildInviteLink(invitation.token);

        return {
          invite: {
            createdAt: invitation.createdAt.toISOString(),
            email: invitation.email ?? email,
            expiresAt: invitation.expiresAt.toISOString(),
            id: invitation.id,
            link,
            policy: input.policy ?? null,
            role: invitation.role,
            status: invitation.status,
          },
          link,
        };
      },
    ),

  getTeamContext: teamProcedure.query(async ({ ctx }): Promise<{ isAdmin: boolean }> => {
    const caller = await ctx.serverDB.query.users.findFirst({
      columns: { role: true },
      where: eq(users.id, ctx.userId),
    });

    return { isAdmin: caller?.role === 'admin' };
  }),

  listInvites: adminProcedure.query(async ({ ctx }): Promise<TeamInviteDisplay[]> => {
    const teamWorkspace = await ctx.serverDB.query.workspaces.findFirst({
      where: eq(workspaces.slug, TEAM_WORKSPACE_SLUG),
    });
    if (!teamWorkspace) return [];

    const settings = (teamWorkspace.settings ?? {}) as Record<string, unknown>;
    const stagedPolicies = (settings[TEAM_PENDING_INVITE_POLICIES_KEY] ?? {}) as Record<
      string,
      UserModelPolicy | undefined
    >;

    const invitations = await ctx.workspaceMemberModel.listPendingInvitations(teamWorkspace.id);

    const now = new Date();
    const stale = invitations.filter((invitation) => invitation.expiresAt <= now);
    const pending = invitations.filter((invitation) => invitation.expiresAt > now);

    // Opportunistically flag stale invitations so they stop matching `status = 'pending'`
    if (stale.length > 0) {
      await Promise.all(
        stale.map((invitation) =>
          ctx.workspaceMemberModel.updateInvitationStatus(invitation.id, 'expired'),
        ),
      );
    }

    return pending
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((invitation) => ({
        createdAt: invitation.createdAt.toISOString(),
        email: invitation.email ?? '',
        expiresAt: invitation.expiresAt.toISOString(),
        id: invitation.id,
        link: buildInviteLink(invitation.token),
        policy: stagedPolicies[invitation.id] ?? null,
        role: invitation.role,
        status: invitation.status,
      }));
  }),

  listMembers: adminProcedure.query(async ({ ctx }): Promise<TeamMemberDisplay[]> => {
    const teamWorkspace = await ctx.serverDB.query.workspaces.findFirst({
      where: eq(workspaces.slug, TEAM_WORKSPACE_SLUG),
    });

    // One settings read for the whole member list — never N per-user policy lookups
    const settings = (teamWorkspace?.settings ?? {}) as Record<string, unknown>;
    const policies = (settings[TEAM_MEMBER_POLICIES_KEY] ?? {}) as Record<
      string,
      UserModelPolicy | undefined
    >;

    const memberColumns = {
      avatar: users.avatar,
      banExpires: users.banExpires,
      banReason: users.banReason,
      banned: users.banned,
      email: users.email,
      fullName: users.fullName,
      id: users.id,
      role: users.role,
      username: users.username,
    };

    const rows = teamWorkspace
      ? await ctx.serverDB
          .select({ ...memberColumns, joinedTeamAt: workspaceMembers.joinedAt })
          .from(users)
          .leftJoin(
            workspaceMembers,
            and(
              eq(workspaceMembers.userId, users.id),
              eq(workspaceMembers.workspaceId, teamWorkspace.id),
              isNull(workspaceMembers.deletedAt),
            ),
          )
          .orderBy(users.createdAt)
      : (await ctx.serverDB.select(memberColumns).from(users).orderBy(users.createdAt)).map(
          (row) => ({ ...row, joinedTeamAt: null as Date | null }),
        );

    return rows.map((row) => ({
      avatar: row.avatar,
      banExpires: row.banExpires ? row.banExpires.toISOString() : null,
      banReason: row.banReason,
      banned: Boolean(row.banned),
      email: row.email,
      fullName: row.fullName,
      id: row.id,
      isAdmin: row.role === 'admin',
      joinedTeamAt: row.joinedTeamAt ? row.joinedTeamAt.toISOString() : null,
      policy: policies[row.id] ?? null,
      username: row.username,
    }));
  }),

  restoreUser: adminProcedure
    .input(z.object({ userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.serverDB
        .update(users)
        .set({ banExpires: null, banReason: null, banned: false })
        .where(eq(users.id, input.userId));

      return { success: true };
    }),

  revokeInvite: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.workspaceMemberModel.updateInvitationStatus(input.id, 'revoked');
      // Drop the staged policy so it can never be picked up by a future acceptance
      await ctx.teamPolicyModel.stageInvitePolicy(input.id, null);

      return { success: true };
    }),

  setUserPolicy: adminProcedure
    .input(z.object({ policy: userModelPolicySchema.nullable(), userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.teamPolicyModel.setPolicyForUser(input.userId, input.policy);
      invalidateTeamPolicyCache(input.userId);

      return { success: true };
    }),

  suspendUser: adminProcedure
    .input(z.object({ reason: z.string().optional(), userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      if (input.userId === ctx.userId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'CANNOT_SUSPEND_SELF' });
      }

      await ctx.serverDB
        .update(users)
        .set({ banReason: input.reason ?? null, banned: true })
        .where(eq(users.id, input.userId));

      // Kill live better-auth sessions so the ban takes effect immediately,
      // not on next session refresh.
      await ctx.serverDB.delete(session).where(eq(session.userId, input.userId));

      invalidateTeamPolicyCache(input.userId);

      return { success: true };
    }),
});

export type TeamRouter = typeof teamRouter;
