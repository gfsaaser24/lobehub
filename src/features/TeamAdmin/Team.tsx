'use client';

import { Flexbox, FluentEmoji, Icon } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { UserPlusIcon } from 'lucide-react';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { MAX_WIDTH } from '@/const/layoutTokens';
import SettingHeader from '@/routes/(main)/settings/features/SettingHeader';

import { useTeamContext } from './hooks';
import InviteModal from './InviteModal';
import InvitesSection from './InvitesSection';
import MembersTable from './MembersTable';

const Forbidden = memo(() => {
  const { t } = useTranslation('error');
  return (
    <Flexbox align={'center'} justify={'center'} style={{ minHeight: '100%', width: '100%' }}>
      <h1
        style={{
          filter: 'blur(8px)',
          fontSize: `min(${MAX_WIDTH / 3}px, 50vw)`,
          fontWeight: 'bolder',
          margin: 0,
          opacity: 0.12,
          position: 'absolute',
          zIndex: 0,
        }}
      >
        403
      </h1>
      <FluentEmoji emoji={'🚫'} size={64} />
      <h2 style={{ fontWeight: 'bold', marginTop: '1em', textAlign: 'center' }}>
        {t('forbidden.title')}
      </h2>
      <div style={{ lineHeight: '1.8', marginBottom: '2em', textAlign: 'center' }}>
        {t('forbidden.desc')}
      </div>
      <Button type={'primary'} onClick={() => (window.location.href = '/')}>
        {t('forbidden.backHome')}
      </Button>
    </Flexbox>
  );
});

Forbidden.displayName = 'TeamAdminForbidden';

const Team = memo(() => {
  const { t } = useTranslation('team');
  const { data, isLoading } = useTeamContext();
  const [inviteOpen, setInviteOpen] = useState(false);

  // Don't paint the 403 before the team context resolves — that would briefly
  // flash the forbidden screen for admins landing directly on the URL.
  if (isLoading && !data) return null;
  if (!data?.isAdmin) return <Forbidden />;

  return (
    <>
      <SettingHeader
        title={t('title')}
        extra={
          <Button
            icon={<Icon icon={UserPlusIcon} />}
            size={'small'}
            type={'primary'}
            onClick={() => setInviteOpen(true)}
          >
            {t('invite.button')}
          </Button>
        }
      />

      <Flexbox gap={24}>
        <InvitesSection />
        <MembersTable />
      </Flexbox>

      <InviteModal open={inviteOpen} onClose={() => setInviteOpen(false)} />
    </>
  );
});

Team.displayName = 'TeamAdmin';

export default Team;
