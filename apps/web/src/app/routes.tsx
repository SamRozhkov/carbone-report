import type { RouteObject } from 'react-router';
import { Navigate } from 'react-router';
import { RequireAdmin, RequireUser } from './guards';
import { Layout } from './Layout';
import { BackupsPage } from '../pages/admin/BackupsPage';
import { CategoriesPage } from '../pages/admin/CategoriesPage';
import { DatasourcesPage } from '../pages/admin/DatasourcesPage';
import { GroupsPage } from '../pages/admin/GroupsPage';
import { TemplatesPage } from '../pages/admin/TemplatesPage';
import { UsersPage } from '../pages/admin/UsersPage';
import { HistoryPage } from '../pages/HistoryPage';
import { LoginPage } from '../pages/LoginPage';
import { NotFoundPage } from '../pages/NotFoundPage';
import { ReportRunRoute } from '../pages/ReportRunPage';
import { ReportsPage } from '../pages/ReportsPage';

export const routes: RouteObject[] = [
  { path: '/login', element: <LoginPage /> },
  {
    element: <RequireUser />,
    children: [
      {
        path: '/',
        element: <Layout />,
        children: [
          { index: true, element: <Navigate to="/reports" replace /> },
          { path: 'reports', element: <ReportsPage /> },
          { path: 'reports/:id', element: <ReportRunRoute /> },
          { path: 'history', element: <HistoryPage /> },
          {
            path: 'admin',
            element: <RequireAdmin />,
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
              { path: 'groups', element: <GroupsPage /> },
              { path: 'categories', element: <CategoriesPage /> },
              { path: 'backups', element: <BackupsPage /> },
              {
                path: 'help',
                // Справка — отдельный чанк: в основном бандле она не нужна.
                lazy: async () => ({
                  Component: (await import('../pages/admin/help/HelpPage')).HelpPage,
                }),
              },
            ],
          },
        ],
      },
    ],
  },
  { path: '*', element: <NotFoundPage /> },
];
