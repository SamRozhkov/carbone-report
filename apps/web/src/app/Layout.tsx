import {
  Archive,
  ArrowRightFromSquare,
  ArrowRightToSquare,
  CircleInfo,
  CircleQuestion,
  ClockArrowRotateLeft,
  Database,
  FileText,
  Folders,
  Globe,
  Layers,
  Moon,
  PencilToLine,
  Person,
  Persons,
  PersonsLock,
  ShieldCheck,
  Sparkles,
  Sun,
} from '@gravity-ui/icons';
import type { AsideHeaderItem } from '@gravity-ui/navigation';
import { AsideHeader, FooterItem } from '@gravity-ui/navigation';
import { useToaster } from '@gravity-ui/uikit';
import { useQueryClient } from '@tanstack/react-query';
import { useContext, useState, type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { Outlet, useLocation, useNavigate } from 'react-router';
import { api } from '../api/endpoints';
import { meKey, useMe } from '../api/session';
import { AssistantPanel } from '../features/assistant/AssistantPanel';
import { AssistantBridgeProvider } from '../features/assistant/bridge';
import { clearAssistant } from '../features/assistant/storage';
import { useAssistantChat } from '../features/assistant/useAssistantChat';
import { LocaleSwitcher } from '../i18n/LocaleSwitcher';
import { AboutDialog } from './AboutDialog';
import { webBuild } from './buildInfo';
import { usePermissions } from './permissions';
import { ThemeContext } from './theme';

/** Черновики превью, параметры тестового прогона и диалог ассистента не должны достаться следующему пользователю. */
function purgeUserStorage() {
  clearAssistant();
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

/** Мост ассистента и редактора (§51.5) — над оболочкой: его читают и панель, и страницы. */
export function Layout() {
  return (
    <AssistantBridgeProvider>
      <LayoutShell />
    </AssistantBridgeProvider>
  );
}

function LayoutShell() {
  const me = useMe().data;
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const queryClient = useQueryClient();
  const toaster = useToaster();
  const { theme, setTheme } = useContext(ThemeContext);
  const [compact, setCompact] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const { t } = useTranslation();
  const assistant = useAssistantChat();

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
    item('reports', t('common:nav.reports'), FileText, '/reports'),
    item('history', t('common:nav.history'), ClockArrowRotateLeft, '/history'),
    item('signature', t('common:nav.signature'), PencilToLine, '/signature'),
  ];
  const { isAdmin, canAuthor, canManageAccess } = usePermissions();
  const sectionItems: AsideHeaderItem[] = [
    ...(canAuthor
      ? [item('templates', t('common:nav.templates'), Layers, '/admin/templates')]
      : []),
    ...(isAdmin
      ? [
          item('datasources', t('common:nav.datasources'), Database, '/admin/datasources'),
          item('users', t('common:nav.users'), Persons, '/admin/users'),
          item('assistant', t('common:nav.assistant'), Sparkles, '/admin/assistant'),
        ]
      : []),
    ...(canManageAccess
      ? [
          item('groups', t('common:nav.groups'), PersonsLock, '/admin/groups'),
          item('categories', t('common:nav.categories'), Folders, '/admin/categories'),
          item('access', t('common:nav.access'), ShieldCheck, '/admin/access'),
        ]
      : []),
    // §26.3: пункт есть, только если API настроен на агент бэкапа.
    ...(isAdmin && me?.features?.backups
      ? [item('backups', t('common:nav.backups'), Archive, '/admin/backups')]
      : []),
    ...(canAuthor ? [item('help', t('common:nav.help'), CircleQuestion, '/admin/help')] : []),
  ];
  if (sectionItems.length > 0) {
    menuItems.push({ id: 'admin-divider', title: '', type: 'divider' }, ...sectionItems);
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
    <>
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
            {me?.features?.assistant && (
              <FooterItem
                id="assistant"
                title={t('common:assistant.open')}
                icon={Sparkles}
                compact={isCompact}
                current={assistant.open}
                onItemClick={() => assistant.setOpen(!assistant.open)}
              />
            )}
            <FooterItem
              id="about"
              title={t('common:shell.version', { version: webBuild.version })}
              icon={CircleInfo}
              compact={isCompact}
              onItemClick={() => setAboutOpen(true)}
            />
            <FooterItem
              id="theme"
              title={t(theme === 'dark' ? 'common:shell.themeLight' : 'common:shell.themeDark')}
              icon={theme === 'dark' ? Sun : Moon}
              compact={isCompact}
              onItemClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            />
            <LocaleSwitcher
              persist="server"
              renderControl={({ ref, triggerProps }) => (
                // Клавиши (стрелки, Enter, Esc) от кнопки пункта всплывают сюда — как у обычного Select.
                <div ref={ref as Ref<HTMLDivElement>} onKeyDown={triggerProps.onKeyDown}>
                  <FooterItem
                    id="locale"
                    title={t('common:locale.title')}
                    icon={Globe}
                    compact={isCompact}
                    onItemClick={(_item, _collapsed, e) => triggerProps.onClick?.(e)}
                    menuItemAriaProps={{
                      'aria-haspopup': triggerProps['aria-haspopup'],
                      'aria-expanded': triggerProps['aria-expanded'],
                      'aria-controls': triggerProps['aria-controls'],
                    }}
                  />
                </div>
              )}
            />
            <FooterItem id="me" title={me?.login ?? ''} icon={Person} compact={isCompact} />
            <FooterItem
              id="logout"
              title={t('common:shell.logout')}
              icon={ArrowRightFromSquare}
              compact={isCompact}
              onItemClick={() =>
                void signOut(api.logout, {
                  title: t('common:shell.logoutFailedTitle'),
                  content: t('common:shell.logoutFailedText'),
                })
              }
            />
            <FooterItem
              id="logout-all"
              title={t('common:shell.logoutAll')}
              icon={ArrowRightToSquare}
              compact={isCompact}
              onItemClick={() =>
                void signOut(api.logoutAll, {
                  title: t('common:shell.logoutAllFailedTitle'),
                  content: t('common:shell.logoutAllFailedText'),
                })
              }
            />
          </>
        )}
        renderContent={() => (
          <>
            <main className="cr-content">
              <Outlet />
            </main>
            {me?.features?.assistant && assistant.open && <AssistantPanel chat={assistant} />}
          </>
        )}
      />
      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
    </>
  );
}
