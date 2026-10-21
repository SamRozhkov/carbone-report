import { z } from 'zod';
import type { App } from '../../app';
import type { AppDeps } from '../../deps';
import { AppError } from '../../lib/errors';
import { currentUser, type Guards } from '../auth/guards';
import { createFeedbackSender, type FeedbackSender } from './mail';

const FeedbackBody = z
  .object({
    subject: z
      .string()
      .trim()
      .min(1)
      .max(160)
      // eslint-disable-next-line no-control-regex -- Запрет управляющих символов в заголовке письма.
      .regex(/^[^\r\n\x00-\x1f\x7f]+$/),
    message: z.string().trim().min(1).max(5000),
    replyTo: z.email().max(254).optional(),
    // Только pathname: не включаем в письмо query с токенами или параметры OIDC.
    page: z
      .string()
      .max(500)
      // eslint-disable-next-line no-control-regex -- Путь не должен содержать токены и управляющие символы.
      .regex(/^\/(?!\/)[^?#\r\n\x00]*$/),
  })
  .strict();

export function registerFeedbackRoutes(
  app: App,
  deps: Pick<AppDeps, 'config'>,
  guards: Pick<Guards, 'requireUser'>,
  sender?: FeedbackSender,
): void {
  const send = sender ?? (deps.config.feedback ? createFeedbackSender(deps.config.feedback) : null);
  // Лимит вызывается после requireUser: общая квота по учётной записи во всех репликах.
  const limit = app.rateLimit({
    max: 5,
    timeWindow: '15 minutes',
    keyGenerator: (req) => `feedback:${currentUser(req).id}`,
    errorResponseBuilder: () =>
      new AppError('FEEDBACK_LIMIT', 429, 'Не более 5 обращений за 15 минут. Попробуйте позже.'),
  });
  app.post(
    '/api/feedback',
    {
      bodyLimit: 32 * 1024,
      schema: { body: FeedbackBody },
      preHandler: [guards.requireUser, limit],
    },
    async (req, reply) => {
      if (!send)
        throw new AppError(
          'FEEDBACK_UNAVAILABLE',
          503,
          'Обратная связь пока не настроена. Обратитесь к администратору сервиса.',
        );
      const user = currentUser(req);
      try {
        const id = await send({ ...req.body, login: user.login, userId: user.id });
        return reply.status(200).send({ status: 'sent', id });
      } catch {
        // SMTP-ответ может содержать адреса/учётные данные: не выводим исходную ошибку.
        req.log.warn({ userId: user.id }, 'Feedback SMTP submission failed');
        throw new AppError(
          'FEEDBACK_SEND_FAILED',
          502,
          'Не удалось передать сообщение почтовому серверу. Текст сохранён в форме; попробуйте позже.',
        );
      }
    },
  );
}
