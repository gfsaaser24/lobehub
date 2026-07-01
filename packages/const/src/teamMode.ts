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

/** Path segment for shareable invite links: `${APP_URL}/invite/${token}` */
export const TEAM_INVITE_PATH = '/invite';
