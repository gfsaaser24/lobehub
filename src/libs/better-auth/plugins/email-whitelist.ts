import { APIError } from 'better-auth/api';
import { type BetterAuthPlugin } from 'better-auth/types';
import { and, eq, gt, sql } from 'drizzle-orm';

import { workspaceInvitations } from '@/database/schemas/workspace';
import { authEnv } from '@/envs/auth';

/**
 * Parse comma-separated email whitelist string into array.
 */
function parseAllowedEmails(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Check if email is allowed based on whitelist.
 * Supports full email (user@example.com) or domain (example.com).
 */
export function isEmailAllowed(email: string): boolean {
  const allowedList = parseAllowedEmails(authEnv.AUTH_ALLOWED_EMAILS);
  if (allowedList.length === 0) return true;

  const domain = email.split('@')[1];

  return allowedList.some((item) => {
    // Full email match
    if (item.includes('@')) return item === email;
    // Domain match
    return item === domain;
  });
}

/**
 * Team mode (fork): a non-whitelisted email may still register when it holds a
 * pending, unexpired team invitation (matched case-insensitively by email).
 *
 * The server db is imported lazily INSIDE the check — `serverDB` spins up a
 * database connection at module scope, and this plugin file is also imported
 * in client-adjacent tests that must not touch it. Any lookup failure is
 * treated as "not invited" so the whitelist stays fail-closed.
 */
async function hasPendingTeamInvitation(email: string): Promise<boolean> {
  try {
    const { serverDB } = await import('@lobechat/database');

    const [invitation] = await serverDB
      .select({ id: workspaceInvitations.id })
      .from(workspaceInvitations)
      .where(
        and(
          sql`lower(${workspaceInvitations.email}) = ${email.toLowerCase()}`,
          eq(workspaceInvitations.status, 'pending'),
          gt(workspaceInvitations.expiresAt, new Date()),
        ),
      )
      .limit(1);

    return !!invitation;
  } catch (error) {
    console.error('[email-whitelist] failed to check team invitations:', error);
    return false;
  }
}

/**
 * Better Auth plugin to restrict registration to whitelisted emails/domains.
 * Intercepts user creation (both email signup and SSO) via databaseHooks.
 */
export const emailWhitelist = (): BetterAuthPlugin => ({
  id: 'email-whitelist',
  init() {
    return {
      options: {
        databaseHooks: {
          user: {
            create: {
              before: async (user) => {
                if (!user.email) return { data: user };

                if (!isEmailAllowed(user.email) && !(await hasPendingTeamInvitation(user.email))) {
                  throw new APIError('FORBIDDEN', {
                    code: 'EMAIL_NOT_ALLOWED',
                    message: 'EMAIL_NOT_ALLOWED',
                  });
                }

                return { data: user };
              },
            },
          },
        },
      },
    };
  },
});
