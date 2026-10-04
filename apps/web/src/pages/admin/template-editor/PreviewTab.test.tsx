import type { TemplateAdminDetails } from '@carbone-reports/shared';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { adminTemplate } from '../../../test/fixtures';
import { mockApi, renderWithProviders } from '../../../test/utils';
import { PreviewTab } from './PreviewTab';

const t = { ...adminTemplate, params: [] } as unknown as TemplateAdminDetails;
const pdfRoute = {
  method: 'POST',
  path: '/api/templates/t1/preview',
  raw: '%PDF-1.7',
  headers: { 'content-type': 'application/pdf' },
};

describe('PreviewTab', () => {
  it('данные: запрос, сохранение для дерева тегов, показ JSON', async () => {
    const onPreviewData = vi.fn();
    const { calls } = mockApi([
      {
        method: 'POST',
        path: '/api/templates/t1/preview',
        body: { company: { name: 'ООО' }, params: {} },
      },
    ]);
    renderWithProviders(
      <PreviewTab
        template={t}
        testParams={{}}
        onTestParams={() => {}}
        previewData={null}
        onPreviewData={onPreviewData}
      />,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Получить данные' }));
    await waitFor(() =>
      expect(onPreviewData).toHaveBeenCalledWith({ company: { name: 'ООО' }, params: {} }),
    );
    expect(calls[0]!.body).toEqual({ params: {}, mode: 'data' });
  });

  it('PDF показывается во фрейме', async () => {
    mockApi([pdfRoute]);
    renderWithProviders(
      <PreviewTab
        template={t}
        testParams={{}}
        onTestParams={() => {}}
        previewData={{ a: 1 }}
        onPreviewData={() => {}}
      />,
    );
    expect(screen.getByLabelText('Данные отчёта')).toHaveValue(JSON.stringify({ a: 1 }, null, 2));
    await userEvent.click(screen.getByRole('button', { name: 'Сгенерировать PDF' }));
    expect(await screen.findByTitle('PDF-предпросмотр')).toHaveAttribute(
      'src',
      expect.stringMatching(/^blob:/),
    );
  });

  it('поля VALIDATION ложатся на параметры, прочие ключи остаются в общей ошибке', async () => {
    const tp = {
      ...adminTemplate,
      params: [{ name: 'from', label: 'С даты', type: 'string', required: true }],
    } as unknown as TemplateAdminDetails;
    mockApi([
      {
        method: 'POST',
        path: '/api/templates/t1/preview',
        status: 400,
        body: {
          error: {
            code: 'VALIDATION',
            message: 'bad',
            details: { fields: { from: 'обязателен', other: 'странно' } },
          },
        },
      },
    ]);
    renderWithProviders(
      <PreviewTab
        template={tp}
        testParams={{ from: '' }}
        onTestParams={() => {}}
        previewData={null}
        onPreviewData={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Получить данные' }));
    expect(await screen.findByText('обязателен')).toBeInTheDocument();
    expect(await screen.findByText('other: странно')).toBeInTheDocument();
  });

  it('PDF сбрасывается при смене параметров, blob-URL освобождается', async () => {
    mockApi([pdfRoute]);
    const created: string[] = [];
    const revoked: string[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      const u = `blob:pdf-${created.length}`;
      created.push(u);
      return u;
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u) => void revoked.push(u));
    function Harness() {
      const [p, setP] = useState<Record<string, never>>({});
      return (
        <>
          <button onClick={() => setP({ ...p })}>same</button>
          <button onClick={() => setP({ x: 1 } as never)}>change</button>
          <PreviewTab
            template={t}
            testParams={p}
            onTestParams={() => {}}
            previewData={null}
            onPreviewData={() => {}}
          />
        </>
      );
    }
    renderWithProviders(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Сгенерировать PDF' }));
    expect(await screen.findByTitle('PDF-предпросмотр')).toBeInTheDocument();
    // новый объект с теми же значениями — PDF остаётся
    await userEvent.click(screen.getByRole('button', { name: 'same' }));
    expect(screen.getByTitle('PDF-предпросмотр')).toBeInTheDocument();
    await act(async () => {
      screen.getByRole('button', { name: 'change' }).click();
    });
    await waitFor(() => expect(screen.queryByTitle('PDF-предпросмотр')).not.toBeInTheDocument());
    expect(revoked).toContain('blob:pdf-0');
  });
});
