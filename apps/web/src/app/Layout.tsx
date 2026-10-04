import {
  ArrowRightFromSquare,
  ClockArrowRotateLeft,
  Database,
  FileText,
  Layers,
  Moon,
  Person,
  Persons,
  Sun,
} from '@gravity-ui/icons';
import type { AsideHeaderItem } from '@gravity-ui/navigation';
import { AsideHeader, FooterItem } from '@gravity-ui/navigation';
import { useToaster } from '@gravity-ui/uikit';
import { useQueryClient } from '@tanstack/react-query';
import { useContext, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';
import { api } from '../api/endpoints';
import { meKey, useMe } from '../api/session';
import { ThemeContext } from './theme';

export function Layout() {
  const me = useMe().data;
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const queryClient = useQueryClient();
  const toaster = useToaster();
  const { theme, setTheme } = useContext(ThemeContext);
  const [compact, setCompact] = useState(false);

  const item = (
    id: string,
    title: string,
    icon: AsideHeaderItem['icon'],
    to: string,
  ): AsideHeaderItem => ({
    id,
    title,
    icon,
    current: pathname === to || pathname.startsWith(`${to}/`),
    onItemClick: () => navigate(to),
  });

  const menuItems: AsideHeaderItem[] = [
    item('reports', 'Отчёты', FileText, '/reports'),
    item('history', 'История', ClockArrowRotateLeft, '/history'),
  ];
  if (me?.role === 'admin') {
    menuItems.push(
      { id: 'admin-divider', title: '', type: 'divider' },
      item('templates', 'Шаблоны', Layers, '/admin/templates'),
      item('datasources', 'Источники данных', Database, '/admin/datasources'),
      item('users', 'Пользователи', Persons, '/admin/users'),
    );
  }

  const logout = async () => {
    let failed = false;
    await api.logout().catch(() => {
      failed = true;
    });
    queryClient.clear();
    queryClient.setQueryData(meKey, null);
    navigate('/login', { replace: true });
    if (failed) {
      toaster.add({
        name: 'logout-failed',
        theme: 'warning',
        title: 'Не удалось завершить сессию на сервере',
        content: 'Закройте браузер, если компьютер общий.',
      });
    }
  };

  return (
    <AsideHeader
      logo={{
        text: 'Carbone Reports',
        icon: FileText,
        onClick: (e) => {
          e.preventDefault();
          navigate('/reports');
        },
      }}
      compact={compact}
      onChangeCompact={setCompact}
      menuItems={menuItems}
      menuOverflow="scroll"
      headerDecoration
      renderFooter={({ compact: isCompact }) => (
        <>
          <FooterItem
            id="theme"
            title={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
            icon={theme === 'dark' ? Sun : Moon}
            compact={isCompact}
            onItemClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          />
          <FooterItem id="me" title={me?.login ?? ''} icon={Person} compact={isCompact} />
          <FooterItem
            id="logout"
            title="Выйти"
            icon={ArrowRightFromSquare}
            compact={isCompact}
            onItemClick={logout}
          />
        </>
      )}
      renderContent={() => (
        <main className="cr-content">
          <Outlet />
        </main>
      )}
    />
  );
}
