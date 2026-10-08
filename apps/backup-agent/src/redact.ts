const SECRET_NAME = /PASSWORD|SECRET|TOKEN|KEY/;
export const MIN_SECRET_LENGTH = 6;

export type Redact = (s: string) => string;

/**
 * Фильтр вывода дочерних процессов (§26.1): значения переменных окружения с PASSWORD, SECRET,
 * TOKEN или KEY в имени длиной от 6 символов заменяются на «***». Пароль Redis входит в
 * REDIS_URL, имя переменной его не выдаёт, поэтому он добавляется отдельно.
 */
export function createRedactor(env: NodeJS.ProcessEnv): Redact {
  const values = new Set<string>();
  for (const [k, v] of Object.entries(env))
    if (v && v.length >= MIN_SECRET_LENGTH && SECRET_NAME.test(k)) values.add(v);
  const url = env.REDIS_URL;
  if (url && URL.canParse(url)) {
    const password = decodeURIComponent(new URL(url).password);
    if (password.length >= MIN_SECRET_LENGTH) values.add(password);
  }
  // Длинные первыми: значение, содержащее другое значение, вырезается целиком.
  const sorted = [...values].sort((a, b) => b.length - a.length);
  return (s) => sorted.reduce((acc, v) => acc.split(v).join('***'), s);
}
