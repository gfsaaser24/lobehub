'use client';

import { BRANDING_NAME } from '@lobechat/business-const';
import type { InvitePublicInfo } from '@lobechat/types';
import { Flexbox, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';

import Loading from '@/components/Loading/BrandTextLoading';
import AuthCard from '@/features/AuthCard';

/**
 * Team mode (fork): public landing page for shareable invite links
 * (`/join/:token` — `/invite` is reserved by upstream's cloud invites). Looks
 * up the invitation via the public info endpoint (`/api/auth/invite/:token`,
 * masked email only — the unmasked variant is fetched by the signup form) and
 * funnels valid invitees into `/signup?invite={token}`, where the token is
 * threaded to the server as the enforced signup capability.
 */
const InviteLandingPage = () => {
  const { t } = useTranslation('auth');
  const navigate = useNavigate();
  const { token } = useParams<{ token: string }>();

  const [info, setInfo] = useState<InvitePublicInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const fetchInviteInfo = async () => {
      if (!token) {
        if (!cancelled) setLoading(false);
        return;
      }

      try {
        const response = await fetch(`/api/auth/invite/${encodeURIComponent(token)}`);
        const data: InvitePublicInfo = await response.json();
        if (!cancelled) setInfo(data);
      } catch {
        if (!cancelled) setInfo(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void fetchInviteInfo();

    return () => {
      cancelled = true;
    };
  }, [token]);

  if (loading) return <Loading debugId="InviteLanding" />;

  if (!info?.valid) {
    return (
      <AuthCard
        subtitle={t('teamInvite.invalid.description')}
        title={t('teamInvite.invalid.title')}
        footer={
          <Link to={'/signin'}>
            <Button block size={'large'}>
              {t('teamInvite.backToSignIn')}
            </Button>
          </Link>
        }
      />
    );
  }

  return (
    <AuthCard
      title={t('teamInvite.title')}
      subtitle={
        info.inviterName
          ? t('teamInvite.description', { appName: BRANDING_NAME, inviter: info.inviterName })
          : t('teamInvite.descriptionNoInviter', { appName: BRANDING_NAME })
      }
    >
      <Flexbox gap={16}>
        {info.email && (
          <Text type={'secondary'}>{t('teamInvite.emailHint', { email: info.email })}</Text>
        )}
        <Button
          block
          size={'large'}
          type={'primary'}
          onClick={() => navigate(`/signup?invite=${encodeURIComponent(token ?? '')}`)}
        >
          {t('teamInvite.accept')}
        </Button>
      </Flexbox>
    </AuthCard>
  );
};

export default InviteLandingPage;
