/**
 * Team mode (fork feature) — per-user model access policy.
 *
 * Semantics:
 * - A user with NO policy entry is UNRESTRICTED (grandfathers pre-team users and the admin).
 * - `allowedProviders: 'all'` → every provider (subject to optional allowedModels narrowing).
 * - `allowedProviders: string[]` → only these provider ids; empty array = no providers at all.
 * - `allowedModels[providerId]` absent → every model of that (allowed) provider.
 * - `allowedModels[providerId]: string[]` → only these model ids for that provider; empty = none.
 * - Users with `users.role === 'admin'` bypass policy entirely (never filtered, never guarded).
 *
 * Storage: policies live in the team workspace's `workspaces.settings` jsonb under
 * `forkTeamMemberPolicies` (keyed by userId). Policies chosen at invite time are staged under
 * `forkPendingInvitePolicies` (keyed by invitationId) and moved on acceptance.
 */
export interface UserModelPolicy {
  allowedModels?: Record<string, 'all' | string[]>;
  allowedProviders: 'all' | string[];
}

export interface TeamMemberDisplay {
  avatar?: string | null;
  banExpires?: string | null;
  banReason?: string | null;
  banned: boolean;
  email?: string | null;
  fullName?: string | null;
  id: string;
  isAdmin: boolean;
  joinedTeamAt?: string | null;
  policy?: UserModelPolicy | null;
  username?: string | null;
}

export interface TeamInviteDisplay {
  createdAt: string;
  email: string;
  expiresAt: string;
  id: string;
  link: string;
  policy?: UserModelPolicy | null;
  role: string;
  status: string;
}

export interface InvitePublicInfo {
  /** masked, e.g. `a***@editmypodcast.agency` */
  email?: string;
  expired: boolean;
  inviterName?: string;
  status: 'accepted' | 'expired' | 'pending' | 'revoked';
  valid: boolean;
}

/** Returns true when the policy allows this provider (model unspecified). */
export const policyAllowsProvider = (
  policy: UserModelPolicy | null | undefined,
  providerId: string,
): boolean => {
  if (!policy) return true;
  if (policy.allowedProviders === 'all') return true;
  return policy.allowedProviders.includes(providerId);
};

/** Returns true when the policy allows this provider+model pair. */
export const policyAllowsModel = (
  policy: UserModelPolicy | null | undefined,
  providerId: string,
  modelId: string,
): boolean => {
  if (!policy) return true;
  if (!policyAllowsProvider(policy, providerId)) return false;
  const models = policy.allowedModels?.[providerId];
  if (!models || models === 'all') return true;
  return models.includes(modelId);
};
