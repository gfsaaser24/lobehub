import { APIError } from 'better-auth/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Get mocked module
import { authEnv } from '@/envs/auth';

import { emailWhitelist, isEmailAllowed } from './email-whitelist';

// Mock authEnv
vi.mock('@/envs/auth', () => ({
  authEnv: {
    AUTH_ALLOWED_EMAILS: undefined as string | undefined,
  },
}));

// Mock the server db so the invitation lookup never opens a real connection.
// The chain mirrors `serverDB.select().from().where().limit()`.
const dbMocks = vi.hoisted(() => {
  const limit = vi.fn<() => Promise<{ id: string }[]>>(async () => []);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));

  return { from, limit, select, where };
});

vi.mock('@lobechat/database', () => ({
  serverDB: { select: dbMocks.select },
}));

describe('isEmailAllowed', () => {
  beforeEach(() => {
    // Reset to undefined before each test
    (authEnv as { AUTH_ALLOWED_EMAILS: string | undefined }).AUTH_ALLOWED_EMAILS = undefined;
  });

  describe('when whitelist is empty', () => {
    it('should allow all emails when AUTH_ALLOWED_EMAILS is undefined', () => {
      expect(isEmailAllowed('anyone@example.com')).toBe(true);
    });

    it('should allow all emails when AUTH_ALLOWED_EMAILS is empty string', () => {
      (authEnv as { AUTH_ALLOWED_EMAILS: string | undefined }).AUTH_ALLOWED_EMAILS = '';
      expect(isEmailAllowed('anyone@example.com')).toBe(true);
    });
  });

  describe('domain matching', () => {
    beforeEach(() => {
      (authEnv as { AUTH_ALLOWED_EMAILS: string | undefined }).AUTH_ALLOWED_EMAILS =
        'example.com,company.org';
    });

    it('should allow email from whitelisted domain', () => {
      expect(isEmailAllowed('user@example.com')).toBe(true);
      expect(isEmailAllowed('admin@company.org')).toBe(true);
    });

    it('should reject email from non-whitelisted domain', () => {
      expect(isEmailAllowed('user@other.com')).toBe(false);
    });

    it('should be case-sensitive for domain', () => {
      expect(isEmailAllowed('user@Example.com')).toBe(false);
      expect(isEmailAllowed('user@EXAMPLE.COM')).toBe(false);
    });
  });

  describe('exact email matching', () => {
    beforeEach(() => {
      (authEnv as { AUTH_ALLOWED_EMAILS: string | undefined }).AUTH_ALLOWED_EMAILS =
        'admin@special.com,vip@other.com';
    });

    it('should allow exact email match', () => {
      expect(isEmailAllowed('admin@special.com')).toBe(true);
      expect(isEmailAllowed('vip@other.com')).toBe(true);
    });

    it('should reject different email at same domain', () => {
      expect(isEmailAllowed('user@special.com')).toBe(false);
    });

    it('should be case-sensitive for email', () => {
      expect(isEmailAllowed('Admin@special.com')).toBe(false);
    });
  });

  describe('mixed domain and email matching', () => {
    beforeEach(() => {
      (authEnv as { AUTH_ALLOWED_EMAILS: string | undefined }).AUTH_ALLOWED_EMAILS =
        'example.com,admin@other.com';
    });

    it('should allow any email from whitelisted domain', () => {
      expect(isEmailAllowed('anyone@example.com')).toBe(true);
    });

    it('should allow specific whitelisted email', () => {
      expect(isEmailAllowed('admin@other.com')).toBe(true);
    });

    it('should reject non-whitelisted email from non-whitelisted domain', () => {
      expect(isEmailAllowed('user@other.com')).toBe(false);
    });
  });

  describe('whitespace handling', () => {
    it('should trim whitespace from whitelist entries', () => {
      (authEnv as { AUTH_ALLOWED_EMAILS: string | undefined }).AUTH_ALLOWED_EMAILS =
        ' example.com , admin@other.com ';
      expect(isEmailAllowed('user@example.com')).toBe(true);
      expect(isEmailAllowed('admin@other.com')).toBe(true);
    });

    it('should filter empty entries', () => {
      (authEnv as { AUTH_ALLOWED_EMAILS: string | undefined }).AUTH_ALLOWED_EMAILS =
        'example.com,,other.com';
      expect(isEmailAllowed('user@example.com')).toBe(true);
      expect(isEmailAllowed('user@other.com')).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should reject malformed email without @', () => {
      (authEnv as { AUTH_ALLOWED_EMAILS: string | undefined }).AUTH_ALLOWED_EMAILS = 'example.com';
      expect(isEmailAllowed('invalid-email')).toBe(false);
    });

    it('should handle email with multiple @ symbols', () => {
      (authEnv as { AUTH_ALLOWED_EMAILS: string | undefined }).AUTH_ALLOWED_EMAILS = 'example.com';
      // split('@')[1] returns 'middle@example.com', which won't match 'example.com'
      expect(isEmailAllowed('user@middle@example.com')).toBe(false);
    });
  });
});

describe('emailWhitelist plugin — team invitation fallback', () => {
  const getCreateBeforeHook = () => {
    const plugin = emailWhitelist();
    // This plugin's init ignores the better-auth context argument
    const result = (plugin.init as () => any)();
    return result.options.databaseHooks.user.create.before as (
      user: { email?: string },
      ctx?: { headers?: HeadersInit; path?: string; request?: Request } | null,
    ) => Promise<{ data: { email?: string } }>;
  };

  const signupCtx = (token?: string) => ({
    headers: token ? new Headers({ 'x-team-invite-token': token }) : new Headers(),
    path: '/sign-up/email',
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Restore the select chain wiring cleared by clearAllMocks
    dbMocks.select.mockReturnValue({ from: dbMocks.from } as any);
    dbMocks.from.mockReturnValue({ where: dbMocks.where } as any);
    dbMocks.where.mockReturnValue({ limit: dbMocks.limit } as any);
    dbMocks.limit.mockResolvedValue([]);
    (authEnv as { AUTH_ALLOWED_EMAILS: string | undefined }).AUTH_ALLOWED_EMAILS = 'example.com';
  });

  describe('token-based validation (email/password signups)', () => {
    it('should allow a non-whitelisted email when the invite token header matches an invitation', async () => {
      dbMocks.limit.mockResolvedValue([{ id: 'inv_1' }]);
      const before = getCreateBeforeHook();

      await expect(before({ email: 'invited@other.com' }, signupCtx('tok_1'))).resolves.toEqual({
        data: { email: 'invited@other.com' },
      });
      // Exactly one lookup: the token query. No email-only fallback ran.
      expect(dbMocks.select).toHaveBeenCalledTimes(1);
    });

    it('should read the token from plain-object headers too', async () => {
      dbMocks.limit.mockResolvedValue([{ id: 'inv_1' }]);
      const before = getCreateBeforeHook();

      await expect(
        before(
          { email: 'invited@other.com' },
          { headers: { 'x-team-invite-token': 'tok_1' }, path: '/sign-up/email' },
        ),
      ).resolves.toEqual({ data: { email: 'invited@other.com' } });
      expect(dbMocks.select).toHaveBeenCalledTimes(1);
    });

    it('should block when the token matches nothing (wrong token, wrong email, expired, revoked)', async () => {
      // The SQL restricts to token = $1 AND lower(email) = $2 AND
      // status='pending' AND expires_at > now(), so every mismatch comes back
      // as zero rows.
      dbMocks.limit.mockResolvedValue([]);
      const before = getCreateBeforeHook();

      await expect(before({ email: 'invited@other.com' }, signupCtx('tok_wrong'))).rejects.toBeInstanceOf(
        APIError,
      );
      // No email-only fallback once a token is supplied — the token is the capability
      expect(dbMocks.select).toHaveBeenCalledTimes(1);
    });

    it('should require the token for email/password signups even when an email-matching invitation exists', async () => {
      // An invitation for this email IS pending, but the signup request
      // carries no token header — knowing the invited address must not be
      // enough for password signups.
      dbMocks.limit.mockResolvedValue([{ id: 'inv_1' }]);
      const before = getCreateBeforeHook();

      await expect(before({ email: 'invited@other.com' }, signupCtx())).rejects.toBeInstanceOf(
        APIError,
      );
      // The email-only lookup was never attempted
      expect(dbMocks.select).not.toHaveBeenCalled();
    });
  });

  describe('email-only fallback (headerless non-password paths, e.g. SSO/magic link)', () => {
    it('should allow a non-whitelisted email that holds a pending unexpired invitation', async () => {
      dbMocks.limit.mockResolvedValue([{ id: 'inv_1' }]);
      const before = getCreateBeforeHook();

      await expect(
        before({ email: 'invited@other.com' }, { path: '/callback/google' }),
      ).resolves.toEqual({ data: { email: 'invited@other.com' } });
      expect(dbMocks.select).toHaveBeenCalledTimes(1);
    });

    it('should fall back to email-only matching when no endpoint context exists at all', async () => {
      // Internal creation paths invoke the hook without a request context
      dbMocks.limit.mockResolvedValue([{ id: 'inv_1' }]);
      const before = getCreateBeforeHook();

      await expect(before({ email: 'invited@other.com' })).resolves.toEqual({
        data: { email: 'invited@other.com' },
      });
      expect(dbMocks.select).toHaveBeenCalledTimes(1);
    });

    it('should keep blocking when the lookup finds nothing (absent invitations)', async () => {
      dbMocks.limit.mockResolvedValue([]);
      const before = getCreateBeforeHook();

      await expect(before({ email: 'stranger@other.com' })).rejects.toBeInstanceOf(APIError);
      expect(dbMocks.select).toHaveBeenCalledTimes(1);
    });

    it('should keep blocking expired/revoked invitations (filtered out by the query itself)', async () => {
      // The SQL restricts to status='pending' AND expires_at > now(), so expired or
      // revoked invitations come back as zero rows — same as no invitation at all.
      dbMocks.limit.mockResolvedValue([]);
      const before = getCreateBeforeHook();

      await expect(before({ email: 'expired-invite@other.com' })).rejects.toBeInstanceOf(APIError);
      await expect(before({ email: 'revoked-invite@other.com' })).rejects.toBeInstanceOf(APIError);
    });
  });

  it('should never hit the invitation query for whitelisted emails', async () => {
    const before = getCreateBeforeHook();

    await expect(before({ email: 'user@example.com' })).resolves.toEqual({
      data: { email: 'user@example.com' },
    });
    expect(dbMocks.select).not.toHaveBeenCalled();
  });

  it('should never hit the invitation query when the whitelist is empty', async () => {
    (authEnv as { AUTH_ALLOWED_EMAILS: string | undefined }).AUTH_ALLOWED_EMAILS = undefined;
    const before = getCreateBeforeHook();

    await expect(before({ email: 'anyone@anywhere.com' })).resolves.toEqual({
      data: { email: 'anyone@anywhere.com' },
    });
    expect(dbMocks.select).not.toHaveBeenCalled();
  });

  it('should stay fail-closed when the invitation lookup errors', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    dbMocks.limit.mockRejectedValue(new Error('db down'));
    const before = getCreateBeforeHook();

    await expect(before({ email: 'invited@other.com' })).rejects.toBeInstanceOf(APIError);

    consoleError.mockRestore();
  });

  it('should stay fail-closed when the token lookup errors', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    dbMocks.limit.mockRejectedValue(new Error('db down'));
    const before = getCreateBeforeHook();

    await expect(before({ email: 'invited@other.com' }, signupCtx('tok_1'))).rejects.toBeInstanceOf(
      APIError,
    );

    consoleError.mockRestore();
  });

  it('should pass through users without an email', async () => {
    const before = getCreateBeforeHook();

    await expect(before({})).resolves.toEqual({ data: {} });
    expect(dbMocks.select).not.toHaveBeenCalled();
  });
});
