import { ThemeProvider, Toaster, ToasterComponent, ToasterProvider } from '@gravity-ui/uikit';
import { QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { createQueryClient } from './queryClient';
import { routes } from './routes';
import { ThemeContext, useThemePreference } from './theme';

const router = createBrowserRouter(routes);
const queryClient = createQueryClient();
const toaster = new Toaster();

export function App() {
  const [theme, setTheme] = useThemePreference();
  return (
    <ThemeProvider theme={theme} lang="ru">
      <ThemeContext.Provider value={{ theme, setTheme }}>
        <ToasterProvider toaster={toaster}>
          <QueryClientProvider client={queryClient}>
            <RouterProvider router={router} />
          </QueryClientProvider>
          <ToasterComponent />
        </ToasterProvider>
      </ThemeContext.Provider>
    </ThemeProvider>
  );
}
