import '@gravity-ui/uikit/styles/styles.css';
import './app/global.css';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';

// Без StrictMode: двойное монтирование пересоздаёт редактор OnlyOffice.
createRoot(document.getElementById('root')!).render(<App />);
