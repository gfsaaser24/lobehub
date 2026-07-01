'use client';

import { type TeamInviteDisplay } from '@lobechat/types';
import { ActionIcon, copyToClipboard, Flexbox, Tag, Text } from '@lobehub/ui';
import { App, Popconfirm } from 'antd';
import { createStaticStyles } from 'antd-style';
import { CopyIcon, Trash2Icon } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { teamService } from '@/services/team';

import { useTeamInvites } from './hooks';
import { daysUntil, maskEmail } from './utils';

const styles = createStaticStyles(({ css, cssVar }) => ({
  item: css`
    align-items: center;
    justify-content: space-between;

    padding-block: ${cssVar.paddingXS};
    padding-inline: ${cssVar.paddingSM};
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};

    background: ${cssVar.colorBgContainer};
  `,
}));

const InvitesSection = memo(() => {
  const { t } = useTranslation('team');
  const { message } = App.useApp();

  const { data: invites, mutate } = useTeamInvites();

  const handleCopy = async (invite: TeamInviteDisplay) => {
    await copyToClipboard(invite.link);
    message.success(t('invite.linkCopied'));
  };

  const handleRevoke = async (invite: TeamInviteDisplay) => {
    try {
      await teamService.revokeInvite(invite.id);
      message.success(t('invites.revokeSuccess'));
      await mutate();
    } catch (error) {
      message.error((error as Error).message || t('common.actionFailed'));
    }
  };

  if (!invites || invites.length === 0) return null;

  return (
    <Flexbox gap={12}>
      <Text strong fontSize={16}>
        {t('invites.title')}
      </Text>
      <Flexbox gap={8}>
        {invites.map((invite) => {
          const days = daysUntil(invite.expiresAt);

          return (
            <Flexbox horizontal className={styles.item} key={invite.id}>
              <Flexbox horizontal align={'center'} gap={8}>
                <Text>{maskEmail(invite.email)}</Text>
                <Tag>{t(invite.role === 'viewer' ? 'invite.role.viewer' : 'invite.role.member')}</Tag>
                <Text fontSize={12} type={'secondary'}>
                  {days > 0
                    ? t('invites.expiresInDays', { count: days })
                    : t('invites.expired')}
                </Text>
              </Flexbox>
              <Flexbox horizontal align={'center'} gap={4}>
                <ActionIcon
                  icon={CopyIcon}
                  size={'small'}
                  title={t('invite.copyLink')}
                  onClick={() => handleCopy(invite)}
                />
                <Popconfirm
                  cancelText={t('common.cancel')}
                  okButtonProps={{ danger: true }}
                  okText={t('invites.revokeConfirmOk')}
                  title={t('invites.revokeConfirm')}
                  onConfirm={() => handleRevoke(invite)}
                >
                  <ActionIcon icon={Trash2Icon} size={'small'} title={t('invites.revoke')} />
                </Popconfirm>
              </Flexbox>
            </Flexbox>
          );
        })}
      </Flexbox>
    </Flexbox>
  );
});

InvitesSection.displayName = 'TeamInvitesSection';

export default InvitesSection;
