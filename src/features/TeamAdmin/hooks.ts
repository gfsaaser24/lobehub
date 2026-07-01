import { useClientDataSWR } from '@/libs/swr';
import { teamService } from '@/services/team';
import { useUserStore } from '@/store/user';
import { authSelectors } from '@/store/user/selectors';

export const TeamSwrKey = {
  fetchTeamContext: 'fetchTeamContext',
  fetchTeamInvites: 'fetchTeamInvites',
  fetchTeamMembers: 'fetchTeamMembers',
} as const;

export const useTeamContext = () => {
  const isLogin = useUserStore(authSelectors.isLogin);

  return useClientDataSWR(isLogin ? TeamSwrKey.fetchTeamContext : null, () =>
    teamService.getTeamContext(),
  );
};

/**
 * Whether the current user is a team admin. `isAdmin` stays `false` while
 * loading so admin-only nav entries are hidden by default.
 */
export const useIsTeamAdmin = () => {
  const { data, isLoading } = useTeamContext();

  return { isAdmin: data?.isAdmin ?? false, isLoading };
};

export const useTeamMembers = (enabled: boolean = true) =>
  useClientDataSWR(enabled ? TeamSwrKey.fetchTeamMembers : null, () => teamService.listMembers());

export const useTeamInvites = (enabled: boolean = true) =>
  useClientDataSWR(enabled ? TeamSwrKey.fetchTeamInvites : null, () => teamService.listInvites());
