import { type UserModelPolicy } from '@lobechat/types';

import { lambdaClient } from '@/libs/trpc/client';

export interface CreateTeamInviteParams {
  email: string;
  policy?: UserModelPolicy | null;
  role?: 'member' | 'viewer';
}

export class TeamService {
  getTeamContext = async () => {
    return lambdaClient.team.getTeamContext.query();
  };

  listMembers = async () => {
    return lambdaClient.team.listMembers.query();
  };

  listInvites = async () => {
    return lambdaClient.team.listInvites.query();
  };

  createInvite = async (params: CreateTeamInviteParams) => {
    return lambdaClient.team.createInvite.mutate(params);
  };

  revokeInvite = async (id: string) => {
    return lambdaClient.team.revokeInvite.mutate({ id });
  };

  setUserPolicy = async (userId: string, policy: UserModelPolicy | null) => {
    return lambdaClient.team.setUserPolicy.mutate({ policy, userId });
  };

  suspendUser = async (userId: string, reason?: string) => {
    return lambdaClient.team.suspendUser.mutate({ reason, userId });
  };

  restoreUser = async (userId: string) => {
    return lambdaClient.team.restoreUser.mutate({ userId });
  };
}

export const teamService = new TeamService();
