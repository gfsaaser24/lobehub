import { AgentRuntimeErrorType } from '@lobechat/model-runtime';
import { policyAllowsProvider } from '@lobechat/types';
import { type OpenAITTSPayload } from '@lobehub/tts';
import { createOpenaiAudioSpeech } from '@lobehub/tts/server';

import { createBizOpenAI } from '@/app/(backend)/_deprecated/createBizOpenAI';
import { checkAuth } from '@/app/(backend)/middleware/auth';
import { TeamPolicyModel } from '@/database/models/teamPolicy';
import { createSpeechResponse } from '@/server/utils/createSpeechResponse';
import { createErrorResponse } from '@/utils/errorResponse';

export const POST = checkAuth(async (req: Request, { serverDB, userId }) => {
  const payload = (await req.json()) as OpenAITTSPayload;

  // Team mode (fork): this route can execute with the server env
  // OPENAI_API_KEY (createBizOpenAI falls back to it when the caller sends no
  // key), and no ModelRuntime hook runs here — enforce the PROVIDER-level team
  // policy with the checkAuth-provided userId. `allowedModels` narrowing is
  // chat-only (see `UserModelPolicy`), so no model-level check for TTS.
  const policy = await new TeamPolicyModel(serverDB).getEffectivePolicy(userId);
  if (policy && !policyAllowsProvider(policy, 'openai')) {
    return createErrorResponse(AgentRuntimeErrorType.PermissionDenied, {
      error: { provider: 'openai', reason: 'TeamPolicyRestricted' },
      provider: 'openai',
    });
  }

  // need to be refactored with jwt auth mode
  const openaiOrErrResponse = createBizOpenAI(req);

  // if resOrOpenAI is a Response, it means there is an error,just return it
  if (openaiOrErrResponse instanceof Response) return openaiOrErrResponse;

  return createSpeechResponse(
    () =>
      createOpenaiAudioSpeech({
        openai: openaiOrErrResponse as any,
        payload,
      }),
    {
      logTag: 'webapi/tts/openai',
      messages: {
        failure: 'Failed to synthesize speech',
        invalid: 'Unexpected payload from OpenAI TTS',
      },
    },
  );
});
