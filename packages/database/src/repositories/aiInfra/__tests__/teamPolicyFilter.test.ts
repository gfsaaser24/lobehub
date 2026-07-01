import type { AiProviderListItem, AiProviderRuntimeConfig } from '@lobechat/types';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '../../../core/getTestDB';
import { invalidateTeamPolicyCache, TeamPolicyModel } from '../../../models/teamPolicy';
import { users } from '../../../schemas';
import type { LobeChatDatabase } from '../../../type';
import { AiInfraRepos } from '../index';

const adminId = 'tpf-admin';
const memberId = 'tpf-member';
const freeUserId = 'tpf-free';

const mockProviderConfigs = {};

let serverDB: LobeChatDatabase;
let teamPolicyModel: TeamPolicyModel;

const mockProviders = [
  { enabled: true, id: 'openai', name: 'OpenAI', sort: 1, source: 'builtin' as const },
  { enabled: true, id: 'anthropic', name: 'Anthropic', sort: 2, source: 'builtin' as const },
] as AiProviderListItem[];

const builtinModelsByProvider: Record<string, any[]> = {
  anthropic: [
    { abilities: {}, enabled: true, id: 'claude-sonnet-4-5', type: 'chat' },
    { abilities: {}, enabled: true, id: 'claude-haiku-4-5', type: 'chat' },
  ],
  openai: [
    { abilities: {}, enabled: true, id: 'gpt-4', type: 'chat' },
    { abilities: {}, enabled: true, id: 'gpt-5', type: 'chat' },
  ],
};

const createRepo = (userId: string) => {
  const repo = new AiInfraRepos(serverDB, userId, mockProviderConfigs);

  vi.spyOn(repo, 'getAiProviderList').mockResolvedValue(mockProviders);
  vi.spyOn(repo.aiModelModel, 'getAllModels').mockResolvedValue([]);
  vi.spyOn(repo as any, 'fetchBuiltinModels').mockImplementation(
    async (providerId) => builtinModelsByProvider[providerId as string] ?? [],
  );

  return repo;
};

beforeAll(async () => {
  serverDB = await getTestDB();
}, 30000);

beforeEach(async () => {
  vi.clearAllMocks();
  invalidateTeamPolicyCache();

  await serverDB.delete(users);
  await serverDB
    .insert(users)
    .values([{ id: adminId, role: 'admin' }, { id: memberId }, { id: freeUserId }]);

  teamPolicyModel = new TeamPolicyModel(serverDB);
  await teamPolicyModel.ensureTeamWorkspace(adminId);
});

describe('AiInfraRepos — team policy filtering', () => {
  describe('getUserEnabledProviderList', () => {
    it('passes providers through unfiltered when the user has no policy', async () => {
      const repo = createRepo(freeUserId);

      const result = await repo.getUserEnabledProviderList();

      expect(result.map((p) => p.id)).toEqual(['openai', 'anthropic']);
    });

    it('filters providers down to the policy allowlist', async () => {
      await teamPolicyModel.setPolicyForUser(memberId, { allowedProviders: ['openai'] });
      const repo = createRepo(memberId);

      const result = await repo.getUserEnabledProviderList();

      expect(result.map((p) => p.id)).toEqual(['openai']);
    });

    it('returns no providers for an empty allowlist', async () => {
      await teamPolicyModel.setPolicyForUser(memberId, { allowedProviders: [] });
      const repo = createRepo(memberId);

      expect(await repo.getUserEnabledProviderList()).toEqual([]);
    });

    it('bypasses the policy for admins', async () => {
      await teamPolicyModel.setPolicyForUser(adminId, { allowedProviders: [] });
      const repo = createRepo(adminId);

      const result = await repo.getUserEnabledProviderList();

      expect(result.map((p) => p.id)).toEqual(['openai', 'anthropic']);
    });
  });

  describe('getEnabledModels', () => {
    it('passes models through unfiltered when the user has no policy', async () => {
      const repo = createRepo(freeUserId);

      const result = await repo.getEnabledModels();

      expect(result).toHaveLength(4);
    });

    it('drops models of disallowed providers', async () => {
      await teamPolicyModel.setPolicyForUser(memberId, { allowedProviders: ['openai'] });
      const repo = createRepo(memberId);

      const result = await repo.getEnabledModels();

      expect(result.map((m) => `${m.providerId}:${m.id}`).sort()).toEqual([
        'openai:gpt-4',
        'openai:gpt-5',
      ]);
    });

    it('narrows models within an allowed provider via allowedModels', async () => {
      await teamPolicyModel.setPolicyForUser(memberId, {
        allowedModels: { openai: ['gpt-4'] },
        allowedProviders: 'all',
      });
      const repo = createRepo(memberId);

      const result = await repo.getEnabledModels();

      // anthropic has no allowedModels entry → every model allowed
      expect(result.map((m) => `${m.providerId}:${m.id}`).sort()).toEqual([
        'anthropic:claude-haiku-4-5',
        'anthropic:claude-sonnet-4-5',
        'openai:gpt-4',
      ]);
    });

    it('also filters the filterEnabled=false variant (feeds user-facing enabled lists)', async () => {
      await teamPolicyModel.setPolicyForUser(memberId, { allowedProviders: ['anthropic'] });
      const repo = createRepo(memberId);

      const result = await repo.getEnabledModels(false);

      expect(result.map((m) => `${m.providerId}:${m.id}`).sort()).toEqual([
        'anthropic:claude-haiku-4-5',
        'anthropic:claude-sonnet-4-5',
      ]);
    });

    it('bypasses the policy for admins', async () => {
      await teamPolicyModel.setPolicyForUser(adminId, { allowedProviders: [] });
      const repo = createRepo(adminId);

      expect(await repo.getEnabledModels()).toHaveLength(4);
    });
  });

  describe('getAiProviderRuntimeState', () => {
    it('derives the enabled provider/model lists from policy-filtered inputs', async () => {
      // anthropic is an allowed provider but every model of it is denied — it
      // must drop out of enabledChatAiProviders too.
      await teamPolicyModel.setPolicyForUser(memberId, {
        allowedModels: { anthropic: [] },
        allowedProviders: 'all',
      });
      const repo = createRepo(memberId);

      vi.spyOn(repo.aiProviderModel, 'getAiProviderRuntimeConfig').mockResolvedValue(
        {} as Record<string, AiProviderRuntimeConfig>,
      );

      const result = await repo.getAiProviderRuntimeState();

      expect(result.enabledAiModels.map((m) => m.id).sort()).toEqual(['gpt-4', 'gpt-5']);
      expect(result.enabledChatAiProviders.map((p) => p.id)).toEqual(['openai']);
    });
  });
});
