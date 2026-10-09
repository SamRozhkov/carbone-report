// Поток рендера в dev (tsx): загрузчик tsx регистрируется в потоке явно — флаг --import tsx
// в execArgv потока tsx 4 на Node 22 пропускает (регистрирует хуки только в главном потоке).
import { register } from 'tsx/esm/api';

register();
await import('./worker.ts');
