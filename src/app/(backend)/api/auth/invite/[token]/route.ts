import { type InvitePublicInfo } from '@lobechat/types';
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { users } from '@/database/schemas/user';
import { workspaceInvitations } from '@/database/schemas/workspace';
import { serverDB } from '@/database/server';

type Params = Promise<{ token: string }>;

const KNOWN_STATUSES = new Set(['accepted', 'expired', 'pending', 'revoked']);

/**
 * Shape-consistent response for every unknown/bad token so the endpoint can't
 * be used as a token oracle (a wrong token looks exactly like a revoked one).
 */
const invalidInvite = (): InvitePublicInfo => ({ expired: true, status: 'revoked', valid: false });

/** Mask an email for public display, e.g. `a***@editmypodcast.agency` */
const maskEmail = (email: string): string => {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${local?.charAt(0) ?? ''}***@${domain}`;
};

/**
 * Public team invite lookup
 * GET /api/auth/invite/:token
 *
 * Always answers 200 with an InvitePublicInfo shape — never 500s on bad input.
 * With `?full=1` the UNMASKED email is returned, but only while the invitation
 * is still pending and unexpired: the token itself is the capability (the
 * admin handed it to the invitee), and the signup form needs the exact email
 * to prefill it. The email is not a secret to its own recipient.
 */
export async function GET(req: Request, segmentData: { params: Params }) {
  try {
    const { token } = await segmentData.params;

    if (!token || typeof token !== 'string') return NextResponse.json(invalidInvite());

    const [invitation] = await serverDB
      .select({
        email: workspaceInvitations.email,
        expiresAt: workspaceInvitations.expiresAt,
        inviterEmail: users.email,
        inviterFullName: users.fullName,
        inviterUsername: users.username,
        status: workspaceInvitations.status,
      })
      .from(workspaceInvitations)
      .leftJoin(users, eq(users.id, workspaceInvitations.inviterId))
      .where(eq(workspaceInvitations.token, token))
      .limit(1);

    if (!invitation) return NextResponse.json(invalidInvite());

    const rawStatus = (
      KNOWN_STATUSES.has(invitation.status) ? invitation.status : 'revoked'
    ) as InvitePublicInfo['status'];
    const timeExpired =
      !!invitation.expiresAt && new Date(invitation.expiresAt).getTime() <= Date.now();

    const status = rawStatus === 'pending' && timeExpired ? 'expired' : rawStatus;
    const expired = status === 'expired' || timeExpired;
    const valid = status === 'pending';

    const wantsFullEmail = new URL(req.url).searchParams.get('full') === '1';
    const email = invitation.email
      ? valid && wantsFullEmail
        ? invitation.email
        : maskEmail(invitation.email)
      : undefined;

    const inviterName =
      invitation.inviterFullName ||
      invitation.inviterUsername ||
      invitation.inviterEmail?.split('@')[0] ||
      undefined;

    return NextResponse.json({
      email,
      expired,
      inviterName,
      status,
      valid,
    } satisfies InvitePublicInfo);
  } catch (error) {
    console.error('Error resolving invite token:', error);
    return NextResponse.json(invalidInvite());
  }
}
