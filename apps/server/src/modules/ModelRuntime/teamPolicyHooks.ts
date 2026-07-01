import type { ModelRuntimeHooks } from '@lobechat/model-runtime';
import { AgentRuntimeError, AgentRuntimeErrorType } from '@lobechat/model-runtime';
import { policyAllowsModel, policyAllowsProvider } from '@lobechat/types';

import { TeamPolicyModel } from '@/database/models/teamPolicy';
import { type LobeChatDatabase } from '@/database/type';

/**
 * Team mode (fork feature) — server-side enforcement of per-user model access.
 *
 * Builds a `ModelRuntimeHooks` slice whose `before*` hooks load the caller's
 * effective team policy (30s in-process cache — see `TeamPolicyModel`) and
 * refuse disallowed calls BEFORE any upstream call happens. Chat and
 * generateObject enforce provider + `allowedModels` narrowing; embeddings,
 * image and video enforce the PROVIDER allowlist only (`allowedModels` is
 * chat-only — see `UserModelPolicy` in `@lobechat/types`).
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

  const getPolicy = () => teamPolicyModel.getEffectivePolicy(userId);

  /** chat/generateObject only: provider allowlist + `allowedModels` narrowing. */
  const isModelAllowed = async (model: string): Promise<boolean> => {
    const policy = await getPolicy();
    // null policy (no entry, or admin) → unrestricted
    if (!policy) return true;

    return policyAllowsModel(policy, provider, model);
  };

  /**
   * embeddings/image/video: PROVIDER level only. The admin policy editor can
   * only express CHAT models in `allowedModels`, so applying the narrowing to
   * non-chat calls would silently break RAG / file upload / image gen for
   * narrowed users (see `UserModelPolicy` docs in `@lobechat/types`).
   */
  const isProviderAllowed = async (): Promise<boolean> => {
    const policy = await getPolicy();
    if (!policy) return true;

    return policyAllowsProvider(policy, provider);
  };

  const deniedDetail = (model: string) => ({
    model,
    provider,
    reason: 'TeamPolicyRestricted',
  });

  const deniedMessage = (model: string) =>
    `Your team policy does not allow model "${model}" on provider "${provider}". Ask your team admin for access.`;

  const providerDeniedMessage = () =>
    `Your team policy does not allow provider "${provider}". Ask your team admin for access.`;

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
      if (await isProviderAllowed()) return;

      throw AgentRuntimeError.createImage({
        error: deniedDetail(payload.model),
        errorType: AgentRuntimeErrorType.PermissionDenied,
        provider,
      });
    },
    beforeCreateVideo: async (payload) => {
      if (await isProviderAllowed()) return;

      throw AgentRuntimeError.createVideo({
        error: deniedDetail(payload.model),
        errorType: AgentRuntimeErrorType.PermissionDenied,
        provider,
      });
    },
    beforeEmbeddings: async (payload) => {
      if (await isProviderAllowed()) return;

      throw AgentRuntimeError.chat({
        error: deniedDetail(payload.model),
        errorType: AgentRuntimeErrorType.PermissionDenied,
        message: providerDeniedMessage(),
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
