'use client';

import { type UserModelPolicy } from '@lobechat/types';
import { copyToClipboard, Flexbox, Icon, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { App, Form, Input, Modal, Select } from 'antd';
import { createStaticStyles } from 'antd-style';
import { CopyIcon } from 'lucide-react';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { teamService } from '@/services/team';

import { useTeamInvites } from './hooks';
import ModelAccessEditor from './ModelAccessEditor';

const styles = createStaticStyles(({ css, cssVar }) => ({
  link: css`
    overflow: hidden;

    padding-block: ${cssVar.paddingXS};
    padding-inline: ${cssVar.paddingSM};
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};

    word-break: break-all;

    background: ${cssVar.colorFillQuaternary};
  `,
}));

interface InviteFormValues {
  email: string;
  role: 'member' | 'viewer';
}

interface InviteModalProps {
  onClose: () => void;
  open: boolean;
}

const InviteModal = memo<InviteModalProps>(({ open, onClose }) => {
  const { t } = useTranslation('team');
  const { message } = App.useApp();
  const [form] = Form.useForm<InviteFormValues>();
  const { mutate: mutateInvites } = useTeamInvites();

  const [policy, setPolicy] = useState<UserModelPolicy | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resultLink, setResultLink] = useState<string | null>(null);

  const reset = () => {
    form.resetFields();
    setPolicy(null);
    setResultLink(null);
    setSubmitting(false);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleSubmit = async () => {
    let values: InviteFormValues;
    try {
      values = await form.validateFields();
    } catch {
      // antd already renders the field-level validation errors
      return;
    }

    setSubmitting(true);
    try {
      const { link } = await teamService.createInvite({
        email: values.email.trim(),
        policy,
        role: values.role,
      });
      setResultLink(link);
      await mutateInvites();
    } catch (error) {
      const errorMessage = (error as Error).message || '';
      if (errorMessage.includes('EMAIL_EXISTS')) {
        form.setFields([{ errors: [t('invite.emailExists')], name: 'email' }]);
      } else if (errorMessage.includes('INVITE_EXISTS')) {
        form.setFields([{ errors: [t('invite.inviteExists')], name: 'email' }]);
      } else {
        message.error(errorMessage || t('common.actionFailed'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopy = async () => {
    if (!resultLink) return;
    await copyToClipboard(resultLink);
    message.success(t('invite.linkCopied'));
  };

  return (
    <Modal
      destroyOnHidden
      open={open}
      title={t('invite.title')}
      footer={
        resultLink ? (
          <Button type={'primary'} onClick={handleClose}>
            {t('invite.done')}
          </Button>
        ) : (
          <>
            <Button onClick={handleClose}>{t('common.cancel')}</Button>
            <Button loading={submitting} type={'primary'} onClick={handleSubmit}>
              {t('invite.submit')}
            </Button>
          </>
        )
      }
      onCancel={handleClose}
    >
      {resultLink ? (
        <Flexbox gap={12}>
          <Text>{t('invite.linkReady')}</Text>
          <Flexbox horizontal align={'center'} gap={8}>
            <div className={styles.link}>
              <Text fontSize={12}>{resultLink}</Text>
            </div>
            <Button icon={<Icon icon={CopyIcon} />} onClick={handleCopy}>
              {t('invite.copyLink')}
            </Button>
          </Flexbox>
          <Text fontSize={12} type={'secondary'}>
            {t('invite.expiryNote')}
          </Text>
        </Flexbox>
      ) : (
        <Form form={form} initialValues={{ role: 'member' }} layout={'vertical'}>
          <Form.Item
            label={t('invite.emailLabel')}
            name={'email'}
            rules={[
              { message: t('invite.emailRequired'), required: true },
              { message: t('invite.emailInvalid'), type: 'email' },
            ]}
          >
            <Input placeholder={t('invite.emailPlaceholder')} />
          </Form.Item>
          <Form.Item label={t('invite.roleLabel')} name={'role'}>
            <Select
              options={[
                { label: t('invite.role.member'), value: 'member' },
                { label: t('invite.role.viewer'), value: 'viewer' },
              ]}
            />
          </Form.Item>
          <Form.Item label={t('invite.accessLabel')}>
            <ModelAccessEditor value={policy} onChange={setPolicy} />
          </Form.Item>
        </Form>
      )}
    </Modal>
  );
});

InviteModal.displayName = 'TeamInviteModal';

export default InviteModal;
