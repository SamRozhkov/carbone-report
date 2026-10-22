import './zod-config';
import '@gravity-ui/uikit/styles/styles.css';
import './app/global.css';
import { createRoot } from 'react-dom/client';
import { meKey } from './api/session';
import { App, queryClient } from './app/App';
import { initLocale } from './app/bootstrap';

async function bootstrap() {
  const me = await initLocale();
  // Пользователь уже известен — guard не запрашивает его второй раз.
  if (me !== undefined) queryClient.setQueryData(meKey, me);
  // Без StrictMode: двойное монтирование пересоздаёт редактор OnlyOffice.
  createRoot(document.getElementById('root')!).render(<App />);
}

void bootstrap();
