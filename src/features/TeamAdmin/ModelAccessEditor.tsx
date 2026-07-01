'use client';

import { type UserModelPolicy } from '@lobechat/types';
import { Flexbox, Text } from '@lobehub/ui';
import { Select, Switch } from 'antd';
import { createStaticStyles } from 'antd-style';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useEnabledChatModels } from '@/hooks/useEnabledChatModels';

const styles = createStaticStyles(({ css, cssVar }) => ({
  providerModels: css`
    padding-block: ${cssVar.paddingXS};
    padding-inline: ${cssVar.paddingSM};
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};

    background: ${cssVar.colorFillQuaternary};
  `,
  row: css`
    align-items: center;
    justify-content: space-between;
  `,
}));

interface ModelAccessEditorProps {
  onChange: (policy: UserModelPolicy | null) => void;
  /** `null` = unrestricted (no policy entry) */
  value: UserModelPolicy | null;
}

/**
 * Policy editor shared by the invite modal and the member edit-access modal.
 *
 * - "All providers" on → emits `null` (no policy entry, unrestricted).
 * - Off → emits `{ allowedProviders: string[] }`; per-provider model
 *   multi-selects narrow `allowedModels[providerId]` (empty = all models of
 *   that provider, key omitted).
 */
const ModelAccessEditor = memo<ModelAccessEditorProps>(({ value, onChange }) => {
  const { t } = useTranslation('team');
  const enabledChatModels = useEnabledChatModels();

  const unrestricted = !value || value.allowedProviders === 'all';
  const selectedProviders = useMemo(
    () => (!value || value.allowedProviders === 'all' ? [] : value.allowedProviders),
    [value],
  );

  const providerOptions = useMemo(
    () => enabledChatModels.map((provider) => ({ label: provider.name, value: provider.id })),
    [enabledChatModels],
  );

  const handleAllChange = (checked: boolean) => {
    onChange(checked ? null : { allowedProviders: [] });
  };

  const handleProvidersChange = (providers: string[]) => {
    // Drop stale per-provider model narrowing for providers that are no longer selected
    const nextModels: Record<string, 'all' | string[]> = {};
    for (const [providerId, models] of Object.entries(value?.allowedModels ?? {})) {
      if (providers.includes(providerId)) nextModels[providerId] = models;
    }

    onChange({
      allowedProviders: providers,
      ...(Object.keys(nextModels).length > 0 ? { allowedModels: nextModels } : {}),
    });
  };

  const handleModelsChange = (providerId: string, models: string[]) => {
    if (!value || value.allowedProviders === 'all') return;

    const nextModels: Record<string, 'all' | string[]> = { ...value.allowedModels };
    if (models.length === 0) {
      // Empty selection = every model of this provider → omit the key entirely
      delete nextModels[providerId];
    } else {
      nextModels[providerId] = models;
    }

    onChange({
      allowedProviders: value.allowedProviders,
      ...(Object.keys(nextModels).length > 0 ? { allowedModels: nextModels } : {}),
    });
  };

  return (
    <Flexbox gap={12}>
      <Flexbox horizontal className={styles.row}>
        <Flexbox>
          <Text>{t('access.allProviders')}</Text>
          <Text fontSize={12} type={'secondary'}>
            {t('access.allProvidersDesc')}
          </Text>
        </Flexbox>
        <Switch checked={unrestricted} onChange={handleAllChange} />
      </Flexbox>

      {!unrestricted && (
        <Flexbox gap={12}>
          <Select
            mode={'multiple'}
            options={providerOptions}
            placeholder={t('access.providersPlaceholder')}
            value={selectedProviders}
            onChange={handleProvidersChange}
          />

          {selectedProviders.map((providerId) => {
            const provider = enabledChatModels.find((item) => item.id === providerId);
            if (!provider) return null;

            const rawModels = value?.allowedModels?.[providerId];
            const selectedModels = !rawModels || rawModels === 'all' ? [] : rawModels;

            return (
              <Flexbox className={styles.providerModels} gap={8} key={providerId}>
                <Text fontSize={12} type={'secondary'}>
                  {t('access.modelsLabel', { provider: provider.name })}
                </Text>
                <Select
                  mode={'multiple'}
                  placeholder={t('access.modelsPlaceholder')}
                  value={selectedModels}
                  options={provider.children.map((model) => ({
                    label: model.displayName || model.id,
                    value: model.id,
                  }))}
                  onChange={(models) => handleModelsChange(providerId, models)}
                />
              </Flexbox>
            );
          })}
        </Flexbox>
      )}
    </Flexbox>
  );
});

ModelAccessEditor.displayName = 'ModelAccessEditor';

export default ModelAccessEditor;
