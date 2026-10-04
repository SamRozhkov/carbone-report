import '@gravity-ui/uikit/styles/styles.css';
import './app/global.css';
import { settings } from '@gravity-ui/date-utils';
import { configure } from '@gravity-ui/uikit';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';

async function bootstrap() {
  // ThemeProvider lang не доходит до @gravity-ui/navigation (глобальный i18n uikit),
  // а date-utils по умолчанию английский.
  configure({ lang: 'ru' });
  await settings.loadLocale('ru');
  settings.setLocale('ru');
  // Без StrictMode: двойное монтирование пересоздаёт редактор OnlyOffice.
  createRoot(document.getElementById('root')!).render(<App />);
}

void bootstrap();
