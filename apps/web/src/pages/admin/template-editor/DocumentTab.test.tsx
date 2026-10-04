import type { TemplateAdminDetails } from '@carbone-reports/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { adminTemplate } from '../../../test/fixtures';
import { mockApi, renderWithProviders } from '../../../test/utils';
import { DocumentTab } from './DocumentTab';

const mounts = vi.hoisted(() => ({ count: 0 }));
vi.mock('@onlyoffice/document-editor-react', () => ({
  DocumentEditor: (p: { documentServerUrl: string; config: { document: { key: string } } }) => {
    useEffect(() => {
      mounts.count++;
    }, []);
    return <div data-testid="oo" data-url={p.documentServerUrl} data-key={p.config.document.key} />;
  },
}));

const t = adminTemplate as unknown as TemplateAdminDetails;
const config = {
  document: { fileType: 'docx', key: 'k1', title: 'Счёт.docx', url: 'http://api:3000/internal/x' },
  documentType: 'word',
  editorConfig: {},
  token: 'jwt',
};
const base = {
  template: t,
  testParams: {},
  onTestParams: () => {},
  previewData: null,
  onPreviewData: () => {},
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('DocumentTab', () => {
  it('редактор с конфигом сервера; переключение панели тегов не пересоздаёт редактор', async () => {
    mounts.count = 0;
    mockApi([{ path: '/api/templates/t1/editor-config', body: config }]);
    renderWithProviders(<DocumentTab {...base} />);
    const editor = await screen.findByTestId('oo');
    expect(editor).toHaveAttribute('data-url', '/onlyoffice/');
    expect(editor).toHaveAttribute('data-key', 'k1');
    await userEvent.click(screen.getByRole('button', { name: 'Теги' }));
    await userEvent.click(screen.getByRole('button', { name: 'Теги' }));
    expect(mounts.count).toBe(1);
  });

  it('сохранение: forcesave и ожидание новой версии', async () => {
    let gets = 0;
    const { calls } = mockApi([
      { path: '/api/templates/t1/editor-config', body: config },
      { method: 'POST', path: '/api/templates/t1/save', status: 204 },
      {
        path: '/api/templates/t1',
        handler: () => ({ body: { ...t, version: ++gets >= 2 ? 4 : 3 } }),
      },
    ]);
    renderWithProviders(<DocumentTab {...base} pollMs={5} pollTimeoutMs={2000} />);
    await screen.findByTestId('oo');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText('Сохранено, версия 4')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/templates/t1/save')).toBe(
      true,
    );
  });

  it('документ не открыт → понятное сообщение', async () => {
    mockApi([
      { path: '/api/templates/t1/editor-config', body: config },
      {
        method: 'POST',
        path: '/api/templates/t1/save',
        status: 409,
        body: { error: { code: 'NOT_OPEN', message: 'документ не открыт в редакторе' } },
      },
    ]);
    renderWithProviders(<DocumentTab {...base} />);
    await screen.findByTestId('oo');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText('документ не открыт в редакторе')).toBeInTheDocument();
  });

  it('нет подтверждения за отведённое время → предупреждение', async () => {
    mockApi([
      { path: '/api/templates/t1/editor-config', body: config },
      { method: 'POST', path: '/api/templates/t1/save', status: 204 },
      { path: '/api/templates/t1', body: t },
    ]);
    renderWithProviders(<DocumentTab {...base} pollMs={5} pollTimeoutMs={40} />);
    await screen.findByTestId('oo');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText(/не подтвердил сохранение/)).toBeInTheDocument();
  });

  it('размонтирование во время опроса останавливает его: ни запросов, ни тостов, ни предупреждений React', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let gets = 0;
    mockApi([
      { path: '/api/templates/t1/editor-config', body: config },
      { method: 'POST', path: '/api/templates/t1/save', status: 204 },
      {
        path: '/api/templates/t1',
        handler: () => ({ body: { ...t, version: ++gets >= 3 ? 4 : 3 } }),
      },
    ]);
    const { unmount } = renderWithProviders(
      <DocumentTab {...base} pollMs={20} pollTimeoutMs={5000} />,
    );
    await screen.findByTestId('oo');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(gets).toBeGreaterThanOrEqual(1));
    unmount();
    const after = gets;
    const errorsAtUnmount = errSpy.mock.calls.length; // act-предупреждения до размонтирования не в счёт
    await sleep(200);
    expect(gets).toBe(after);
    expect(screen.queryByText(/Сохранено, версия/)).not.toBeInTheDocument();
    expect(errSpy.mock.calls).toHaveLength(errorsAtUnmount);
  });

  it('повторный клик «Сохранить» во время ожидания не запускает второй опрос', async () => {
    const { calls } = mockApi([
      { path: '/api/templates/t1/editor-config', body: config },
      { method: 'POST', path: '/api/templates/t1/save', status: 204 },
      { path: '/api/templates/t1', body: t },
    ]);
    renderWithProviders(<DocumentTab {...base} pollMs={20} pollTimeoutMs={300} />);
    await screen.findByTestId('oo');
    const btn = screen.getByRole('button', { name: 'Сохранить' });
    await userEvent.click(btn);
    await userEvent.click(btn);
    expect(await screen.findByText(/не подтвердил сохранение/)).toBeInTheDocument();
    expect(
      calls.filter((c) => c.method === 'POST' && c.path === '/api/templates/t1/save'),
    ).toHaveLength(1);
  });
});
