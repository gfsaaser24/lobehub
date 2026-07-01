import { TEAM_INVITE_TOKEN_HEADER } from '@lobechat/const';
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
 * Structural subset of better-auth's `GenericEndpointContext` (not exported
 * from `better-auth/types`) — only the fields the invite gate reads.
 */
interface WhitelistHookContext {
  headers?: HeadersInit | null;
  path?: string;
  request?: Request | null;
}

/**
 * Read the invite token header from the endpoint context of the request that
 * triggered user creation. Returns `null` when the context carries no headers
 * (e.g. internal/admin user creation) or the header is absent.
 */
function readInviteToken(ctx: WhitelistHookContext | null | undefined): string | null {
  try {
    const raw = ctx?.headers ?? ctx?.request?.headers;
    if (!raw) return null;
    // Headers normalizes every HeadersInit shape and lowercases names
    const token = new Headers(raw).get(TEAM_INVITE_TOKEN_HEADER);
    return token?.trim() || null;
  } catch {
    return null;
  }
}

/** True when the creating request is better-auth's email/password signup endpoint. */
function isEmailPasswordSignup(ctx: WhitelistHookContext | null | undefined): boolean {
  return typeof ctx?.path === 'string' && ctx.path.startsWith('/sign-up');
}

/**
 * Team mode (fork): validate an invite TOKEN as the signup capability — the
 * invitation must exist under this exact token, be pending and unexpired, AND
 * be addressed to the signing-up email (case-insensitive). Knowing an invited
 * email is not enough; the unguessable token is required.
 *
 * The server db is imported lazily INSIDE the check — `serverDB` spins up a
 * database connection at module scope, and this plugin file is also imported
 * in client-adjacent tests that must not touch it. Any lookup failure is
 * treated as "not invited" so the whitelist stays fail-closed.
 */
async function hasMatchingInvitationByToken(token: string, email: string): Promise<boolean> {
  try {
    const { serverDB } = await import('@lobechat/database');

    const [invitation] = await serverDB
      .select({ id: workspaceInvitations.id })
      .from(workspaceInvitations)
      .where(
        and(
          eq(workspaceInvitations.token, token),
          sql`lower(${workspaceInvitations.email}) = ${email.toLowerCase()}`,
          eq(workspaceInvitations.status, 'pending'),
          gt(workspaceInvitations.expiresAt, new Date()),
        ),
      )
      .limit(1);

    return !!invitation;
  } catch (error) {
    console.error('[email-whitelist] failed to check invitation by token:', error);
    return false;
  }
}

/**
 * Team mode (fork): email-only invitation lookup — a pending, unexpired
 * invitation addressed to this email (case-insensitive), regardless of token.
 *
 * Only used for creation paths that cannot carry the invite-token header
 * (SSO callbacks, magic link, internal creation) — see the before-hook below.
 * Fail-closed like the token variant.
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
 *
 * Team mode (fork): a non-whitelisted email may still register when it holds
 * a pending, unexpired team invitation. The invite TOKEN is the enforced
 * capability:
 *
 * - Email/password signups (`/sign-up/*`): the signup form attaches the token
 *   as the `TEAM_INVITE_TOKEN_HEADER` header; the invitation must match BOTH
 *   the token and the email. Without the token the signup is rejected even if
 *   a pending invitation exists for that email — email/password proves
 *   nothing about mailbox ownership, so a guessed/leaked invitee address must
 *   not be enough.
 * - Other creation paths (SSO callback, magic link, internal creation) cannot
 *   carry the custom header, so they fall back to the email-only lookup.
 *   Residual risk: someone who learns an invited email could register it
 *   through SSO/magic link without the token — acceptable, because those
 *   flows require the registrant to actually control the mailbox / IdP
 *   account for that address.
 */
export const emailWhitelist = (): BetterAuthPlugin => ({
  id: 'email-whitelist',
  init() {
    return {
      options: {
        databaseHooks: {
          user: {
            create: {
              before: async (user, ctx) => {
                if (!user.email) return { data: user };

                if (isEmailAllowed(user.email)) return { data: user };

                const inviteToken = readInviteToken(ctx);

                if (inviteToken) {
                  // Token supplied — enforce it (token + email must both match)
                  if (await hasMatchingInvitationByToken(inviteToken, user.email)) {
                    return { data: user };
                  }
                } else if (
                  !isEmailPasswordSignup(ctx) &&
                  (await hasPendingTeamInvitation(user.email))
                ) {
                  // Headerless non-password path (SSO/magic link): email-only fallback
                  return { data: user };
                }

                throw new APIError('FORBIDDEN', {
                  code: 'EMAIL_NOT_ALLOWED',
                  message: 'EMAIL_NOT_ALLOWED',
                });
              },
            },
          },
        },
      },
    };
  },
});
