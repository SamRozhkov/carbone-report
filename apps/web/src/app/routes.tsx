import type { RouteObject } from 'react-router';
import { Navigate } from 'react-router';
import { AdminIndex, RequireRole, RequireUser } from './guards';
import { Layout } from './Layout';
import { AccessPage } from '../pages/admin/AccessPage';
import { AssistantPage } from '../pages/admin/AssistantPage';
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
import { SignaturePage } from '../pages/SignaturePage';

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
          { path: 'signature', element: <SignaturePage /> },
          {
            path: 'admin',
            children: [
              { index: true, element: <AdminIndex /> },
              {
                element: <RequireRole allow={(p) => p.canAuthor} />,
                children: [
                  { path: 'templates', element: <TemplatesPage /> },
                  {
                    path: 'templates/:id',
                    // Редактор (Monaco, OnlyOffice) — отдельный чанк.
                    lazy: async () => ({
                      Component: (await import('../pages/admin/template-editor/TemplateEditorPage'))
                        .TemplateEditorPage,
                    }),
                  },
                  {
                    path: 'help',
                    // Справка — отдельный чанк: в основном бандле она не нужна.
                    lazy: async () => ({
                      Component: (await import('../pages/admin/help/HelpPage')).HelpPage,
                    }),
                  },
                ],
              },
              {
                element: <RequireRole allow={(p) => p.canManageAccess} />,
                children: [
                  { path: 'groups', element: <GroupsPage /> },
                  { path: 'categories', element: <CategoriesPage /> },
                  { path: 'access', element: <AccessPage /> },
                ],
              },
              {
                element: <RequireRole allow={(p) => p.isAdmin} />,
                children: [
                  { path: 'datasources', element: <DatasourcesPage /> },
                  { path: 'users', element: <UsersPage /> },
                  { path: 'assistant', element: <AssistantPage /> },
                  { path: 'backups', element: <BackupsPage /> },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
  { path: '*', element: <NotFoundPage /> },
];
