// Поток, повисший при загрузке модулей: не шлёт { ready: true }, но держит цикл событий.
import { setInterval } from 'node:timers';

setInterval(() => {}, 1000);
