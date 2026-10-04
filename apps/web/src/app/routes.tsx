import type { RouteObject } from 'react-router';
import { Navigate } from 'react-router';
import { DatasourcesPage } from '../pages/admin/DatasourcesPage';
import { TemplatesPage } from '../pages/admin/TemplatesPage';
import { UsersPage } from '../pages/admin/UsersPage';
import { HistoryPage } from '../pages/HistoryPage';
import { LoginPage } from '../pages/LoginPage';
import { NotFoundPage } from '../pages/NotFoundPage';
import { ReportRunPage } from '../pages/ReportRunPage';
import { ReportsPage } from '../pages/ReportsPage';

export const routes: RouteObject[] = [
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    children: [
      { index: true, element: <Navigate to="/reports" replace /> },
      { path: 'reports', element: <ReportsPage /> },
      { path: 'reports/:id', element: <ReportRunPage /> },
      { path: 'history', element: <HistoryPage /> },
      {
        path: 'admin',
        children: [
          { index: true, element: <Navigate to="/admin/templates" replace /> },
          { path: 'templates', element: <TemplatesPage /> },
          {
            path: 'templates/:id',
            // Редактор (Monaco, OnlyOffice) — отдельный чанк.
            lazy: async () => ({
              Component: (await import('../pages/admin/template-editor/TemplateEditorPage'))
                .TemplateEditorPage,
            }),
          },
          { path: 'datasources', element: <DatasourcesPage /> },
          { path: 'users', element: <UsersPage /> },
        ],
      },
    ],
  },
  { path: '*', element: <NotFoundPage /> },
];
