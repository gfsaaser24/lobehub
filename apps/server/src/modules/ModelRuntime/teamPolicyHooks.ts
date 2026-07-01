import type { ModelRuntimeHooks } from '@lobechat/model-runtime';
import { AgentRuntimeError, AgentRuntimeErrorType } from '@lobechat/model-runtime';
import { policyAllowsModel } from '@lobechat/types';

import { TeamPolicyModel } from '@/database/models/teamPolicy';
import { type LobeChatDatabase } from '@/database/type';

/**
 * Team mode (fork feature) — server-side enforcement of per-user model access.
 *
 * Builds a `ModelRuntimeHooks` slice whose `before*` hooks load the caller's
 * effective team policy (30s in-process cache — see `TeamPolicyModel`) and
 * refuse disallowed provider/model pairs BEFORE any upstream call happens.
 * Users without a policy entry — and admins (`users.role === 'admin'`) — get
 * `null` back and pass straight through, so unrestricted users (including the
 * embeddings default-provider paths) pay a single cached lookup and nothing
 * else.
 *
 * Designed to be merged with the business/tracing hooks at the ModelRuntime
 * construction site via `mergeModelRuntimeHooks` (see `initModelRuntimeFromDB`).
 */
export const createTeamPolicyHooks = (
  db: LobeChatDatabase,
  userId: string,
  provider: string,
): ModelRuntimeHooks => {
  const teamPolicyModel = new TeamPolicyModel(db);

  const isModelAllowed = async (model: string): Promise<boolean> => {
    const policy = await teamPolicyModel.getEffectivePolicy(userId);
    // null policy (no entry, or admin) → unrestricted
    if (!policy) return true;

    return policyAllowsModel(policy, provider, model);
  };

  const deniedDetail = (model: string) => ({
    model,
    provider,
    reason: 'TeamPolicyRestricted',
  });

  const deniedMessage = (model: string) =>
    `Your team policy does not allow model "${model}" on provider "${provider}". Ask your team admin for access.`;

  return {
    beforeChat: async (payload) => {
      if (await isModelAllowed(payload.model)) return;

      throw AgentRuntimeError.chat({
        error: deniedDetail(payload.model),
        errorType: AgentRuntimeErrorType.PermissionDenied,
        message: deniedMessage(payload.model),
        provider,
      });
    },
    beforeCreateImage: async (payload) => {
      if (await isModelAllowed(payload.model)) return;

      throw AgentRuntimeError.createImage({
        error: deniedDetail(payload.model),
        errorType: AgentRuntimeErrorType.PermissionDenied,
        provider,
      });
    },
    beforeCreateVideo: async (payload) => {
      if (await isModelAllowed(payload.model)) return;

      throw AgentRuntimeError.createVideo({
        error: deniedDetail(payload.model),
        errorType: AgentRuntimeErrorType.PermissionDenied,
        provider,
      });
    },
    beforeEmbeddings: async (payload) => {
      if (await isModelAllowed(payload.model)) return;

      throw AgentRuntimeError.chat({
        error: deniedDetail(payload.model),
        errorType: AgentRuntimeErrorType.PermissionDenied,
        message: deniedMessage(payload.model),
        provider,
      });
    },
    beforeGenerateObject: async (payload) => {
      if (await isModelAllowed(payload.model)) return;

      throw AgentRuntimeError.chat({
        error: deniedDetail(payload.model),
        errorType: AgentRuntimeErrorType.PermissionDenied,
        message: deniedMessage(payload.model),
        provider,
      });
    },
  };
};
