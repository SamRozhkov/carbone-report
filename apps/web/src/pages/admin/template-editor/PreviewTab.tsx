import { Button, Text } from '@gravity-ui/uikit';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../api/endpoints';
import { fieldErrors } from '../../../api/errors';
import { CodeEditor } from '../../../components/CodeEditor';
import { GeneralError } from '../../../components/GeneralError';
import { ParamForm } from '../../../components/ParamForm';
import { pickParams } from '../../../lib/params';
import type { TabProps } from './editorState';

export function PreviewTab({
  template,
  testParams,
  onTestParams,
  previewData,
  onPreviewData,
}: TabProps) {
  const { t } = useTranslation();
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const params = () => pickParams(template.params, testParams);
  const paramsKey = JSON.stringify(testParams);
  const paramsKeyRef = useRef(paramsKey);
  paramsKeyRef.current = paramsKey;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const data = useMutation({
    mutationFn: () => api.templates.previewData(template.id, params()),
    onSuccess: (d) => onPreviewData(d),
  });
  const pdf = useMutation({
    mutationFn: () => {
      const usedKey = paramsKeyRef.current;
      return api.templates.previewPdf(template.id, params()).then((blob) => ({ blob, usedKey }));
    },
    onSuccess: ({ blob, usedKey }) => {
      // Ответ на устаревшие параметры или после ухода со страницы не показываем.
      if (!mounted.current || usedKey !== paramsKeyRef.current) return;
      setPdfUrl(URL.createObjectURL(blob));
    },
  });

  // PDF относится к параметрам, с которыми он создан: при смене параметров сбрасываем.
  useEffect(() => {
    setPdfUrl(null);
  }, [paramsKey]);

  // Освобождаем прошлый blob-URL при замене и при уходе со страницы.
  useEffect(
    () => () => {
      if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    },
    [pdfUrl],
  );

  const dataErrors = fieldErrors(data.error);
  const pdfErrors = fieldErrors(pdf.error);
  const errors = { ...dataErrors, ...pdfErrors };
  const shown = template.params.map((p) => p.name);

  return (
    <div className="cr-run">
      <div className="cr-stack">
        <Text variant="subheader-2">{t('editor:test.params')}</Text>
        {template.params.length === 0 ? (
          <Text color="secondary">{t('editor:test.noParams')}</Text>
        ) : (
          <ParamForm
            templateId={template.id}
            params={template.params}
            values={testParams}
            onChange={onTestParams}
            errors={errors}
          />
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <Button onClick={() => data.mutate()} loading={data.isPending}>
            {t('editor:preview.getData')}
          </Button>
          <Button view="action" onClick={() => pdf.mutate()} loading={pdf.isPending}>
            {t('editor:preview.generatePdf')}
          </Button>
        </div>
        <GeneralError error={data.error} errors={dataErrors} shown={shown} />
        <GeneralError error={pdf.error} errors={pdfErrors} shown={shown} />
      </div>
      <div className="cr-stack">
        {pdfUrl && <iframe title={t('editor:preview.pdfTitle')} src={pdfUrl} className="cr-pdf" />}
        {previewData && (
          <CodeEditor
            language="json"
            readOnly
            value={JSON.stringify(previewData, null, 2)}
            ariaLabel={t('editor:preview.dataAria')}
            height={400}
          />
        )}
        {!pdfUrl && !previewData && <Text color="secondary">{t('editor:preview.empty')}</Text>}
      </div>
    </div>
  );
}
