import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import { z } from 'zod';

const Settings = z
  .object({
    FEEDBACK_TO: z.email().max(254),
    SMTP_HOST: z.string().trim().min(1),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    SMTP_SECURE: z.enum(['true', 'false']).default('false'),
    SMTP_FROM: z.email().max(254),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    if (Boolean(v.SMTP_USER) !== Boolean(v.SMTP_PASSWORD)) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMTP_PASSWORD'],
        message: 'задайте SMTP_USER и SMTP_PASSWORD вместе',
      });
    }
  });

export interface FeedbackSmtpConfig {
  to: string;
  host: string;
  port: number;
  secure: boolean;
  from: string;
  user?: string;
  password?: string;
}

export function loadFeedbackConfig(env: NodeJS.ProcessEnv): FeedbackSmtpConfig | null {
  if (!env.FEEDBACK_ENABLED || env.FEEDBACK_ENABLED === 'false') return null;
  if (env.FEEDBACK_ENABLED !== 'true') throw new Error('FEEDBACK_ENABLED: true или false');
  const parsed = Settings.safeParse(env);
  if (!parsed.success) {
    // Значения окружения (в том числе пароль) не попадают в сообщение об ошибке.
    throw new Error(
      `Неверная конфигурация почты: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  }
  const v = parsed.data;
  return {
    to: v.FEEDBACK_TO,
    host: v.SMTP_HOST,
    port: v.SMTP_PORT,
    secure: v.SMTP_SECURE === 'true',
    from: v.SMTP_FROM,
    user: v.SMTP_USER || undefined,
    password: v.SMTP_PASSWORD || undefined,
  };
}

export interface FeedbackMessage {
  subject: string;
  message: string;
  replyTo?: string;
  page: string;
  login: string;
  userId: string;
}

export type FeedbackSender = (message: FeedbackMessage) => Promise<string>;

/** Получатель задаётся администратором на сервере; браузер не может его изменить. */
export function createFeedbackSender(config: FeedbackSmtpConfig): FeedbackSender {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: !config.secure,
    auth: config.user ? { user: config.user, pass: config.password! } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    debug: false,
  });
  return async (message) => {
    const id = randomUUID();
    const info = await transport.sendMail({
      from: { name: 'Carbone Reports', address: config.from },
      to: config.to,
      replyTo: message.replyTo ? { address: message.replyTo } : undefined,
      subject: `[Carbone Reports] ${message.subject}`,
      text: [
        `Обращение: ${id}`,
        `Пользователь: ${message.login}`,
        `ID пользователя: ${message.userId}`,
        `Почта для ответа: ${message.replyTo || 'не указана'}`,
        `Страница: ${message.page}`,
        `Время (UTC): ${new Date().toISOString()}`,
        '',
        message.message,
      ].join('\n'),
    });
    if (!info.accepted?.includes(config.to) || info.rejected?.length) {
      throw new Error('SMTP did not accept the feedback recipient');
    }
    return id;
  };
}
