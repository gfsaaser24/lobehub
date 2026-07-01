// @vitest-environment node
import { type LobeChatDatabase } from '@lobechat/database';
import { users } from '@lobechat/database/schemas';
import { getTestDB } from '@lobechat/database/test-utils';
import { AgentRuntimeErrorType, ModelRuntime } from '@lobechat/model-runtime';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { invalidateTeamPolicyCache, TeamPolicyModel } from '@/database/models/teamPolicy';

import { createTeamPolicyHooks } from './teamPolicyHooks';

const adminId = 'tph-admin';
const memberId = 'tph-member';
const freeUserId = 'tph-free';

let serverDB: LobeChatDatabase;
let teamPolicyModel: TeamPolicyModel;

beforeEach(async () => {
  invalidateTeamPolicyCache();

  serverDB = await getTestDB();
  teamPolicyModel = new TeamPolicyModel(serverDB);

  await serverDB.delete(users);
  await serverDB.insert(users).values([
    { id: adminId, role: 'admin' },
    { id: memberId },
    { id: freeUserId },
  ]);
  await teamPolicyModel.ensureTeamWorkspace(adminId);
  await teamPolicyModel.setPolicyForUser(memberId, {
    allowedModels: { openai: ['gpt-4'] },
    allowedProviders: ['openai'],
  });
});

describe('createTeamPolicyHooks', () => {
  describe('beforeChat', () => {
    it('passes through for users without a policy (null short-circuit)', async () => {
      const hooks = createTeamPolicyHooks(serverDB, freeUserId, 'openai');

      await expect(
        hooks.beforeChat!({ messages: [], model: 'gpt-5', temperature: 1 }),
      ).resolves.toBeUndefined();
    });

    it('passes through for an allowed provider/model pair', async () => {
      const hooks = createTeamPolicyHooks(serverDB, memberId, 'openai');

      await expect(
        hooks.beforeChat!({ messages: [], model: 'gpt-4', temperature: 1 }),
      ).resolves.toBeUndefined();
    });

    it('throws PermissionDenied for a disallowed model of an allowed provider', async () => {
      const hooks = createTeamPolicyHooks(serverDB, memberId, 'openai');

      await expect(
        hooks.beforeChat!({ messages: [], model: 'gpt-5', temperature: 1 }),
      ).rejects.toMatchObject({
        error: { model: 'gpt-5', provider: 'openai', reason: 'TeamPolicyRestricted' },
        errorType: AgentRuntimeErrorType.PermissionDenied,
        provider: 'openai',
      });
    });

    it('throws PermissionDenied for a disallowed provider', async () => {
      const hooks = createTeamPolicyHooks(serverDB, memberId, 'anthropic');

      await expect(
        hooks.beforeChat!({ messages: [], model: 'claude-sonnet-4-5', temperature: 1 }),
      ).rejects.toMatchObject({
        errorType: AgentRuntimeErrorType.PermissionDenied,
        provider: 'anthropic',
      });
    });

    it('bypasses the policy for admins', async () => {
      await teamPolicyModel.setPolicyForUser(adminId, { allowedProviders: [] });
      const hooks = createTeamPolicyHooks(serverDB, adminId, 'anthropic');

      await expect(
        hooks.beforeChat!({ messages: [], model: 'claude-sonnet-4-5', temperature: 1 }),
      ).resolves.toBeUndefined();
    });

    it('aborts BEFORE the LLM call when merged into a ModelRuntime', async () => {
      const chat = vi.fn();
      const runtime = new ModelRuntime(
        { chat } as any,
        createTeamPolicyHooks(serverDB, memberId, 'anthropic'),
      );

      await expect(
        runtime.chat({ messages: [], model: 'claude-sonnet-4-5', temperature: 1 }),
      ).rejects.toMatchObject({ errorType: AgentRuntimeErrorType.PermissionDenied });

      expect(chat).not.toHaveBeenCalled();
    });
  });

  describe('beforeCreateImage / beforeCreateVideo (provider-level only)', () => {
    it('throws PermissionDenied for an image call on a disallowed provider', async () => {
      const hooks = createTeamPolicyHooks(serverDB, memberId, 'anthropic');

      await expect(
        hooks.beforeCreateImage!({ model: 'some-image-model', params: { prompt: 'a cat' } }),
      ).rejects.toMatchObject({
        errorType: AgentRuntimeErrorType.PermissionDenied,
        provider: 'anthropic',
      });
    });

    it('throws PermissionDenied for a video call on a disallowed provider', async () => {
      const hooks = createTeamPolicyHooks(serverDB, memberId, 'anthropic');

      await expect(
        hooks.beforeCreateVideo!({ model: 'some-video-model', params: { prompt: 'a cat' } }),
      ).rejects.toMatchObject({
        errorType: AgentRuntimeErrorType.PermissionDenied,
        provider: 'anthropic',
      });
    });

    it('image gen on an allowed provider passes even when allowedModels narrows its chat models', async () => {
      // memberId's policy narrows openai to ['gpt-4'] — narrowing is chat-only,
      // so image models of the allowed provider must NOT be blocked.
      const hooks = createTeamPolicyHooks(serverDB, memberId, 'openai');

      await expect(
        hooks.beforeCreateImage!({ model: 'gpt-image-1', params: { prompt: 'a cat' } }),
      ).resolves.toBeUndefined();
    });

    it('video gen on an allowed provider passes even when allowedModels narrows its chat models', async () => {
      const hooks = createTeamPolicyHooks(serverDB, memberId, 'openai');

      await expect(
        hooks.beforeCreateVideo!({ model: 'sora-2', params: { prompt: 'a cat' } }),
      ).resolves.toBeUndefined();
    });
  });

  describe('beforeEmbeddings / beforeGenerateObject', () => {
    it('embeddings pass through untouched for unrestricted users (default provider path)', async () => {
      const hooks = createTeamPolicyHooks(serverDB, freeUserId, 'openai');

      await expect(
        hooks.beforeEmbeddings!({ input: 'hello', model: 'text-embedding-3-small' }),
      ).resolves.toBeUndefined();
    });

    it('embeddings on an allowed provider pass even when allowedModels narrows its chat models', async () => {
      // provider-level check only — otherwise narrowed users silently lose RAG
      const hooks = createTeamPolicyHooks(serverDB, memberId, 'openai');

      await expect(
        hooks.beforeEmbeddings!({ input: 'hello', model: 'text-embedding-3-small' }),
      ).resolves.toBeUndefined();
    });

    it('throws PermissionDenied for embeddings on a disallowed provider', async () => {
      const hooks = createTeamPolicyHooks(serverDB, memberId, 'anthropic');

      await expect(
        hooks.beforeEmbeddings!({ input: 'hello', model: 'voyage-3' }),
      ).rejects.toMatchObject({ errorType: AgentRuntimeErrorType.PermissionDenied });
    });

    it('throws PermissionDenied for a disallowed generateObject model (chat-level narrowing)', async () => {
      const hooks = createTeamPolicyHooks(serverDB, memberId, 'openai');

      await expect(
        hooks.beforeGenerateObject!({ messages: [], model: 'gpt-5' }),
      ).rejects.toMatchObject({ errorType: AgentRuntimeErrorType.PermissionDenied });
    });

    it('passes generateObject through for allowed models', async () => {
      const hooks = createTeamPolicyHooks(serverDB, memberId, 'openai');

      await expect(
        hooks.beforeGenerateObject!({ messages: [], model: 'gpt-4' }),
      ).resolves.toBeUndefined();
    });
  });
});
