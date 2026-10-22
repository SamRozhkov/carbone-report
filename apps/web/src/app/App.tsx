import { ThemeProvider, Toaster, ToasterComponent, ToasterProvider } from '@gravity-ui/uikit';
import { QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { useLocale } from '../i18n';
import { LocaleSync } from '../i18n/LocaleSync';
import { MaintenanceGate } from './MaintenanceGate';
import { createQueryClient } from './queryClient';
import { routes } from './routes';
import { ThemeContext, useThemePreference } from './theme';

const router = createBrowserRouter(routes);
export const queryClient = createQueryClient();
const toaster = new Toaster();

export function App() {
  const [theme, setTheme] = useThemePreference();
  // uikit знает только ru и en (§44.3).
  const lang = useLocale() === 'ru' ? 'ru' : 'en';
  return (
    <ThemeProvider theme={theme} lang={lang}>
      <ThemeContext.Provider value={{ theme, setTheme }}>
        <ToasterProvider toaster={toaster}>
          <QueryClientProvider client={queryClient}>
            <LocaleSync />
            <MaintenanceGate>
              <RouterProvider router={router} />
            </MaintenanceGate>
          </QueryClientProvider>
          <ToasterComponent />
        </ToasterProvider>
      </ThemeContext.Provider>
    </ThemeProvider>
  );
}
