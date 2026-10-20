import { Alert, Button, Card, Text } from '@gravity-ui/uikit';
import { useMutation } from '@tanstack/react-query';
import { cadesErrorText, loadCades } from '../lib/cades';

/** Блок «КриптоПро» на странице «Моя подпись» (§42.7): плагин грузится только по кнопке. */
export function CadesCheck() {
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
      <Text variant="subheader-2">КриптоПро</Text>
      <Text color="secondary">
        Для подписи по ГОСТ нужны КриптоПро CSP, КриптоПро ЭЦП Browser plug-in и сертификат ГОСТ на
        этом компьютере.
      </Text>
      <div>
        <Button onClick={() => check.mutate()} loading={check.isPending}>
          Проверить плагин
        </Button>
      </div>
      {r && (
        <>
          <Text>{`КриптоПро ЭЦП Browser plug-in ${r.plugin}, КриптоПро CSP ${r.csp}`}</Text>
          <Text>{`Действующих сертификатов ГОСТ: ${r.count}`}</Text>
        </>
      )}
      {check.error && <Alert theme="danger" message={cadesErrorText(check.error)} />}
    </Card>
  );
}
