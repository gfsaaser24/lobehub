import { type UserModelPolicy } from '@lobechat/types';

/**
 * Mask an email for display in pending-invite lists, e.g. `ana@example.com` → `a***@example.com`.
 */
export const maskEmail = (email: string): string => {
  const atIndex = email.indexOf('@');
  if (atIndex <= 0) return email;

  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex + 1);

  return `${local.slice(0, 1)}***@${domain}`;
};

export type PolicySummary =
  | { type: 'all' }
  | { type: 'custom' }
  | { count: number; type: 'providers' };

/**
 * Summarize a policy for the members table access column.
 *
 * - no policy / `allowedProviders: 'all'` without model narrowing → unrestricted
 * - `allowedProviders: 'all'` WITH model narrowing → custom
 * - explicit provider list → provider count
 */
export const summarizePolicy = (policy?: UserModelPolicy | null): PolicySummary => {
  if (!policy) return { type: 'all' };

  if (policy.allowedProviders === 'all') {
    const hasModelNarrowing = Object.values(policy.allowedModels ?? {}).some(
      (models) => models !== 'all',
    );
    return hasModelNarrowing ? { type: 'custom' } : { type: 'all' };
  }

  return { count: policy.allowedProviders.length, type: 'providers' };
};

/**
 * Days until `expiresAt` (ISO string), rounded up. Negative or zero means expired.
 */
export const daysUntil = (expiresAt: string, now: Date = new Date()): number => {
  const diff = new Date(expiresAt).getTime() - now.getTime();
  return Math.ceil(diff / 86_400_000);
};
