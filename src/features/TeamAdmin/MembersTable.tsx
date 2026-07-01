'use client';

import { type TeamMemberDisplay, type UserModelPolicy } from '@lobechat/types';
import { Avatar, Flexbox, Tag, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import type { TableColumnsType } from 'antd';
import { App, Modal, Popconfirm, Table } from 'antd';
import { createStaticStyles } from 'antd-style';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { teamService } from '@/services/team';
import { useUserStore } from '@/store/user';
import { userProfileSelectors } from '@/store/user/selectors';

import { useTeamMembers } from './hooks';
import ModelAccessEditor from './ModelAccessEditor';
import { summarizePolicy } from './utils';

const styles = createStaticStyles(({ css, cssVar }) => ({
  table: css`
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorBgContainer};
  `,
}));

const memberName = (member: TeamMemberDisplay) =>
  member.fullName || member.username || member.email || member.id;

const MembersTable = memo(() => {
  const { t } = useTranslation('team');
  const { message } = App.useApp();
  const currentUserId = useUserStore(userProfileSelectors.userId);

  const { data: members, isLoading, mutate } = useTeamMembers();

  const [editingMember, setEditingMember] = useState<TeamMemberDisplay | null>(null);
  const [draftPolicy, setDraftPolicy] = useState<UserModelPolicy | null>(null);
  const [saving, setSaving] = useState(false);

  const openEditAccess = (member: TeamMemberDisplay) => {
    setDraftPolicy(member.policy ?? null);
    setEditingMember(member);
  };

  const handleSavePolicy = async () => {
    if (!editingMember) return;
    setSaving(true);
    try {
      await teamService.setUserPolicy(editingMember.id, draftPolicy);
      message.success(t('access.updateSuccess'));
      setEditingMember(null);
      await mutate();
    } catch (error) {
      message.error((error as Error).message || t('common.actionFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleSuspend = async (member: TeamMemberDisplay) => {
    try {
      await teamService.suspendUser(member.id);
      message.success(t('suspend.success'));
      await mutate();
    } catch (error) {
      message.error((error as Error).message || t('common.actionFailed'));
    }
  };

  const handleRestore = async (member: TeamMemberDisplay) => {
    try {
      await teamService.restoreUser(member.id);
      message.success(t('restore.success'));
      await mutate();
    } catch (error) {
      message.error((error as Error).message || t('common.actionFailed'));
    }
  };

  const renderAccessSummary = (member: TeamMemberDisplay) => {
    // Admins bypass policy entirely
    if (member.isAdmin) return <Text type={'secondary'}>{t('access.all')}</Text>;

    const summary = summarizePolicy(member.policy);
    switch (summary.type) {
      case 'all': {
        return <Text type={'secondary'}>{t('access.all')}</Text>;
      }
      case 'custom': {
        return <Text type={'secondary'}>{t('access.custom')}</Text>;
      }
      case 'providers': {
        return <Text type={'secondary'}>{t('access.providers', { count: summary.count })}</Text>;
      }
    }
  };

  const columns: TableColumnsType<TeamMemberDisplay> = [
    {
      dataIndex: 'member',
      key: 'member',
      render: (_, member) => (
        <Flexbox horizontal align={'center'} gap={12}>
          <Avatar avatar={member.avatar || undefined} size={32} title={memberName(member)} />
          <Flexbox>
            <Flexbox horizontal align={'center'} gap={8}>
              <Text strong>{memberName(member)}</Text>
              {member.id === currentUserId && <Tag>{t('members.you')}</Tag>}
              {member.isAdmin && <Tag color={'gold'}>{t('members.adminBadge')}</Tag>}
            </Flexbox>
            {member.email && (
              <Text fontSize={12} type={'secondary'}>
                {member.email}
              </Text>
            )}
          </Flexbox>
        </Flexbox>
      ),
      title: t('members.columns.member'),
    },
    {
      dataIndex: 'banned',
      key: 'status',
      render: (_, member) =>
        member.banned ? (
          <Tag color={'red'}>{t('members.status.suspended')}</Tag>
        ) : (
          <Tag color={'green'}>{t('members.status.active')}</Tag>
        ),
      title: t('members.columns.status'),
      width: 120,
    },
    {
      dataIndex: 'policy',
      key: 'access',
      render: (_, member) => renderAccessSummary(member),
      title: t('members.columns.access'),
      width: 160,
    },
    {
      key: 'actions',
      render: (_, member) => {
        const isSelf = member.id === currentUserId;

        return (
          <Flexbox horizontal gap={4}>
            <Button
              disabled={member.isAdmin}
              size={'small'}
              title={member.isAdmin ? t('access.adminUnrestricted') : undefined}
              type={'text'}
              onClick={() => openEditAccess(member)}
            >
              {t('members.actions.editAccess')}
            </Button>
            {member.banned ? (
              <Popconfirm
                cancelText={t('common.cancel')}
                okText={t('restore.confirmOk')}
                title={t('restore.confirm', { name: memberName(member) })}
                onConfirm={() => handleRestore(member)}
              >
                <Button size={'small'} type={'text'}>
                  {t('members.actions.restore')}
                </Button>
              </Popconfirm>
            ) : (
              <Popconfirm
                cancelText={t('common.cancel')}
                okButtonProps={{ danger: true }}
                okText={t('suspend.confirmOk')}
                title={t('suspend.confirm', { name: memberName(member) })}
                onConfirm={() => handleSuspend(member)}
              >
                <Button
                  danger
                  disabled={isSelf}
                  size={'small'}
                  title={isSelf ? t('suspend.selfForbidden') : undefined}
                  type={'text'}
                >
                  {t('members.actions.suspend')}
                </Button>
              </Popconfirm>
            )}
          </Flexbox>
        );
      },
      title: t('members.columns.actions'),
      width: 220,
    },
  ];

  return (
    <Flexbox gap={12}>
      <Text strong fontSize={16}>
        {t('members.title')}
      </Text>
      <Table
        className={styles.table}
        columns={columns}
        dataSource={members ?? []}
        loading={isLoading}
        pagination={false}
        rowKey={'id'}
        size={'middle'}
      />

      <Modal
        destroyOnHidden
        confirmLoading={saving}
        okText={t('access.save')}
        open={!!editingMember}
        title={t('access.editTitle', { name: editingMember ? memberName(editingMember) : '' })}
        onCancel={() => setEditingMember(null)}
        onOk={handleSavePolicy}
      >
        <ModelAccessEditor value={draftPolicy} onChange={setDraftPolicy} />
      </Modal>
    </Flexbox>
  );
});

MembersTable.displayName = 'TeamMembersTable';

export default MembersTable;
