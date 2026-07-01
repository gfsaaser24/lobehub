/**
 * Team mode (fork feature) — constants.
 *
 * The team is registered in ONE workspace row (slug TEAM_WORKSPACE_SLUG) whose
 * `settings` jsonb carries fork-namespaced keys. We deliberately reuse upstream's
 * workspace tables (schema + models exist and are OSS-unused) to avoid fork-own
 * migrations that would collide with upstream migration numbering on future syncs.
 */
export const TEAM_WORKSPACE_SLUG = 'team';
export const TEAM_WORKSPACE_NAME = 'Team';

/** workspaces.settings key: Record<userId, UserModelPolicy> */
export const TEAM_MEMBER_POLICIES_KEY = 'forkTeamMemberPolicies';

/** workspaces.settings key: Record<invitationId, UserModelPolicy> — staged until acceptance */
export const TEAM_PENDING_INVITE_POLICIES_KEY = 'forkPendingInvitePolicies';

/**
 * Path segment for shareable invite links: `${APP_URL}/join/${token}`.
 *
 * NOT `/invite` — upstream reserves that prefix for its cloud workspace
 * invites (see `DEFER_REDIRECT_PREFIXES` in `useUserStateRedirect.ts`), so the
 * fork's public invite landing lives under `/join` to avoid colliding on
 * future syncs. The backend lookup API stays at `/api/auth/invite/:token`
 * (internal, no collision).
 */
export const TEAM_INVITE_PATH = '/join';

/**
 * Custom header the signup form attaches to `signUp.email` when the user
 * arrived through an invite link (`/signup?invite={token}`). The
 * email-whitelist before-hook requires this token — not just a matching
 * email — before letting a non-whitelisted address register via
 * email/password.
 */
export const TEAM_INVITE_TOKEN_HEADER = 'x-team-invite-token';
