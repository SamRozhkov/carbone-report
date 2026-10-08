import {
  Archive,
  ArrowRightFromSquare,
  ArrowRightToSquare,
  CircleQuestion,
  ClockArrowRotateLeft,
  Database,
  FileText,
  Folders,
  Layers,
  Moon,
  Person,
  Persons,
  PersonsLock,
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

/** Черновики превью и параметры тестового прогона не должны достаться следующему пользователю. */
function purgeUserStorage() {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith('cr-preview-') || k.startsWith('cr-test-params-'))) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
  } catch {
    // localStorage недоступен
  }
}

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
      item('groups', 'Группы', PersonsLock, '/admin/groups'),
      item('categories', 'Категории', Folders, '/admin/categories'),
      // §26.3: пункт есть, только если API настроен на агент бэкапа.
      ...(me.features?.backups ? [item('backups', 'Бэкапы', Archive, '/admin/backups')] : []),
      item('help', 'Справка по шаблонам', CircleQuestion, '/admin/help'),
    );
  }

  const signOut = async (
    call: () => Promise<void>,
    failure: { title: string; content: string },
  ) => {
    let failed = false;
    await call().catch(() => {
      failed = true;
    });
    queryClient.clear();
    purgeUserStorage();
    queryClient.setQueryData(meKey, null);
    navigate('/login', { replace: true });
    if (failed) {
      toaster.add({
        name: 'logout-failed',
        theme: 'warning',
        ...failure,
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
            onItemClick={() =>
              void signOut(api.logout, {
                title: 'Не удалось завершить сессию на сервере',
                content: 'Закройте браузер, если компьютер общий.',
              })
            }
          />
          <FooterItem
            id="logout-all"
            title="Выйти везде"
            icon={ArrowRightToSquare}
            compact={isCompact}
            onItemClick={() =>
              void signOut(api.logoutAll, {
                title: 'Не удалось завершить сессии на других устройствах',
                content:
                  'Попробуйте ещё раз после входа или попросите администратора завершить сессии.',
              })
            }
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
