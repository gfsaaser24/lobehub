// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GET } from './route';

// Mirror the `serverDB.select().from().leftJoin().where().limit()` chain.
const dbMocks = vi.hoisted(() => {
  const limit = vi.fn<() => Promise<any[]>>(async () => []);
  const where = vi.fn(() => ({ limit }));
  const leftJoin = vi.fn(() => ({ where }));
  const from = vi.fn(() => ({ leftJoin }));
  const select = vi.fn(() => ({ from }));

  return { from, leftJoin, limit, select, where };
});

vi.mock('@/database/server', () => ({
  serverDB: { select: dbMocks.select },
}));

const callRoute = async (token: string, search = '') => {
  const response = await GET(
    new Request(`https://lobehub.com/api/auth/invite/${token}${search}`),
    { params: Promise.resolve({ token }) },
  );
  return { body: await response.json(), status: response.status };
};

const buildRow = (overrides: Record<string, unknown> = {}) => ({
  email: 'invited@other.com',
  expiresAt: new Date(Date.now() + 86_400_000),
  inviterEmail: 'admin@example.com',
  inviterFullName: 'Ada Admin',
  inviterUsername: 'ada',
  status: 'pending',
  ...overrides,
});

describe('invite info route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore the select chain wiring cleared by clearAllMocks
    dbMocks.select.mockReturnValue({ from: dbMocks.from } as any);
    dbMocks.from.mockReturnValue({ leftJoin: dbMocks.leftJoin } as any);
    dbMocks.leftJoin.mockReturnValue({ where: dbMocks.where } as any);
    dbMocks.where.mockReturnValue({ limit: dbMocks.limit } as any);
    dbMocks.limit.mockResolvedValue([]);
  });

  it('should answer 200 with a revoked-looking shape for an unknown token', async () => {
    const { body, status } = await callRoute('nope');

    expect(status).toBe(200);
    expect(body).toEqual({ expired: true, status: 'revoked', valid: false });
  });

  it('should return a valid pending invitation with a masked email', async () => {
    dbMocks.limit.mockResolvedValue([buildRow()]);

    const { body, status } = await callRoute('tok_1');

    expect(status).toBe(200);
    expect(body).toEqual({
      email: 'i***@other.com',
      expired: false,
      inviterName: 'Ada Admin',
      status: 'pending',
      valid: true,
    });
  });

  it('should unmask the email only with ?full=1 on a pending unexpired invitation', async () => {
    dbMocks.limit.mockResolvedValue([buildRow()]);

    const { body } = await callRoute('tok_1', '?full=1');

    expect(body.email).toBe('invited@other.com');
    expect(body.valid).toBe(true);
  });

  it('should report a time-expired pending invitation as expired and keep the email masked', async () => {
    dbMocks.limit.mockResolvedValue([buildRow({ expiresAt: new Date(Date.now() - 1000) })]);

    const { body } = await callRoute('tok_1', '?full=1');

    expect(body).toEqual({
      email: 'i***@other.com',
      expired: true,
      inviterName: 'Ada Admin',
      status: 'expired',
      valid: false,
    });
  });

  it('should report revoked invitations as invalid', async () => {
    dbMocks.limit.mockResolvedValue([buildRow({ status: 'revoked' })]);

    const { body } = await callRoute('tok_1');

    expect(body.status).toBe('revoked');
    expect(body.valid).toBe(false);
    expect(body.email).toBe('i***@other.com');
  });

  it('should fall back to username then email local-part for the inviter name', async () => {
    dbMocks.limit.mockResolvedValue([buildRow({ inviterFullName: null })]);
    let { body } = await callRoute('tok_1');
    expect(body.inviterName).toBe('ada');

    dbMocks.limit.mockResolvedValue([buildRow({ inviterFullName: null, inviterUsername: null })]);
    ({ body } = await callRoute('tok_1'));
    expect(body.inviterName).toBe('admin');
  });

  it('should never 500 when the database query fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    dbMocks.limit.mockRejectedValue(new Error('db down'));

    const { body, status } = await callRoute('tok_1');

    expect(status).toBe(200);
    expect(body).toEqual({ expired: true, status: 'revoked', valid: false });

    consoleError.mockRestore();
  });
});
