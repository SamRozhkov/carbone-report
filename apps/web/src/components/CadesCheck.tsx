import { Alert, Button, Card, Text } from '@gravity-ui/uikit';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { cadesErrorText, loadCades } from '../lib/cades';

/** Блок «КриптоПро» на странице «Моя подпись» (§42.7): плагин грузится только по кнопке. */
export function CadesCheck() {
  const { t } = useTranslation();
  const check = useMutation({
    mutationFn: async () => {
      const cades = await loadCades();
      const versions = await cades.versions();
      return { ...versions, count: (await cades.listCertificates()).length };
    },
  });
  const r = check.data;
  return (
    <Card view="outlined" style={{ padding: 16 }} className="cr-stack">
      <Text variant="subheader-2">{t('signature:cades.title')}</Text>
      <Text color="secondary">{t('signature:cades.intro')}</Text>
      <div>
        <Button onClick={() => check.mutate()} loading={check.isPending}>
          {t('signature:cades.check')}
        </Button>
      </div>
      {r && (
        <>
          <Text>{t('signature:cades.versions', { plugin: r.plugin, csp: r.csp })}</Text>
          <Text>{t('signature:cades.certificates', { n: r.count })}</Text>
        </>
      )}
      {check.error && <Alert theme="danger" message={cadesErrorText(check.error)} />}
    </Card>
  );
}
