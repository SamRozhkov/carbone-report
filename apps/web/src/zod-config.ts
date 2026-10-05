import { z } from 'zod';

// строгая CSP без 'unsafe-eval': zod не проверяет eval через new Function.
// Отдельный модуль, импортируемый первым: zod читает настройку при создании схем
// (z.object), а импорты main.tsx выполняются раньше его собственного кода.
z.config({ jitless: true });
