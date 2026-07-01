// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { asrRouter } from '../asr';

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(() => ({})),
}));

const transcribeMock = vi.fn();
vi.mock('@/server/modules/ModelRuntime', () => ({
  initModelRuntimeFromDB: vi.fn(async () => ({ transcribe: transcribeMock })),
}));

// Team mode (fork): the transcribe route enforces the provider-level policy
// itself (ModelRuntime has no transcription hook).
const getEffectivePolicyMock = vi.fn();
vi.mock('@/database/models/teamPolicy', () => ({
  TeamPolicyModel: vi.fn(() => ({ getEffectivePolicy: getEffectivePolicyMock })),
}));

const findByIdMock = vi.fn();
vi.mock('@/database/models/file', () => ({
  FileModel: vi.fn(() => ({ findById: findByIdMock })),
}));

const getFileByteArrayMock = vi.fn();
vi.mock('@/server/services/file', () => ({
  FileService: vi.fn(() => ({ getFileByteArray: getFileByteArrayMock })),
}));

const caller = asrRouter.createCaller({ jwtPayload: { userId: 'u1' }, userId: 'u1' } as any);

beforeEach(() => {
  transcribeMock.mockResolvedValue({ text: 'hello world' });
  // no policy entry / admin → unrestricted
  getEffectivePolicyMock.mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('asrRouter.transcribe', () => {
  it('transcribes inline base64 audio', async () => {
    const res = await caller.transcribe({
      audioBase64: Buffer.from('audio-bytes').toString('base64'),
      fileName: 'clip.mp3',
      model: 'whisper-1',
      provider: 'openai',
    });

    expect(res).toEqual({ text: 'hello world' });
    expect(findByIdMock).not.toHaveBeenCalled();

    const payload = transcribeMock.mock.calls[0][0];
    expect(payload.file).toBeInstanceOf(File);
    expect(payload.fileName).toBe('clip.mp3');
    expect(await payload.file.text()).toBe('audio-bytes');
  });

  it('resolves a fileId by downloading the bytes from storage', async () => {
    findByIdMock.mockResolvedValue({
      fileType: 'audio/mp4',
      name: 'meeting.m4a',
      url: 's3-key/meeting.m4a',
    });
    getFileByteArrayMock.mockResolvedValue(new Uint8Array(Buffer.from('from-s3')));

    const res = await caller.transcribe({ fileId: 'file_123', model: 'whisper-1' });

    expect(res).toEqual({ text: 'hello world' });
    expect(findByIdMock).toHaveBeenCalledWith('file_123');
    expect(getFileByteArrayMock).toHaveBeenCalledWith('s3-key/meeting.m4a');

    const payload = transcribeMock.mock.calls[0][0];
    expect(payload.fileName).toBe('meeting.m4a');
    expect(payload.file.type).toBe('audio/mp4');
    expect(await payload.file.text()).toBe('from-s3');
  });

  it('rejects when neither fileId nor audioBase64 is provided', async () => {
    await expect(caller.transcribe({ model: 'whisper-1' } as any)).rejects.toThrow();
  });

  it('rejects oversized inline base64 and guides to fileId', async () => {
    // > 3MB decoded → base64 string exceeds the cap
    const tooBig = 'A'.repeat(5 * 1024 * 1024);

    await expect(caller.transcribe({ audioBase64: tooBig, model: 'whisper-1' })).rejects.toThrow(
      /fileId/i,
    );
    expect(transcribeMock).not.toHaveBeenCalled();
  });

  it('rejects when both fileId and audioBase64 are provided', async () => {
    await expect(
      caller.transcribe({
        audioBase64: Buffer.from('x').toString('base64'),
        fileId: 'file_123',
        model: 'whisper-1',
      } as any),
    ).rejects.toThrow();
  });

  it('throws NOT_FOUND when the fileId does not exist', async () => {
    findByIdMock.mockResolvedValue(undefined);

    await expect(caller.transcribe({ fileId: 'missing', model: 'whisper-1' })).rejects.toThrow(
      /not found/i,
    );
    expect(getFileByteArrayMock).not.toHaveBeenCalled();
  });

  it('throws NOT_FOUND when the stored object is gone (NoSuchKey)', async () => {
    findByIdMock.mockResolvedValue({
      fileType: 'audio/mp4',
      name: 'gone.m4a',
      url: 's3-key/gone.m4a',
    });
    getFileByteArrayMock.mockRejectedValue({ Code: 'NoSuchKey' });

    await expect(caller.transcribe({ fileId: 'file_x', model: 'whisper-1' })).rejects.toThrow(
      /no longer available/i,
    );
  });

  describe('team policy enforcement (provider-level)', () => {
    it('throws FORBIDDEN before any provider call when the provider is denied', async () => {
      getEffectivePolicyMock.mockResolvedValue({ allowedProviders: ['anthropic'] });

      await expect(
        caller.transcribe({
          audioBase64: Buffer.from('audio-bytes').toString('base64'),
          model: 'whisper-1',
          provider: 'openai',
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });

      expect(transcribeMock).not.toHaveBeenCalled();
    });

    it('allows an allowed provider even when allowedModels narrows its chat models', async () => {
      // allowedModels is chat-only narrowing — ASR must not be narrowed by it
      getEffectivePolicyMock.mockResolvedValue({
        allowedModels: { openai: ['gpt-4'] },
        allowedProviders: ['openai'],
      });

      const res = await caller.transcribe({
        audioBase64: Buffer.from('audio-bytes').toString('base64'),
        model: 'whisper-1',
        provider: 'openai',
      });

      expect(res).toEqual({ text: 'hello world' });
    });
  });
});
