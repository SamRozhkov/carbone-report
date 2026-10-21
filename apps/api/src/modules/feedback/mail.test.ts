import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFeedbackSender, loadFeedbackConfig } from './mail';

const smtp = vi.hoisted(() => ({ sendMail: vi.fn(), createTransport: vi.fn() }));
vi.mock('nodemailer', () => ({ default: { createTransport: smtp.createTransport } }));

const FEEDBACK_RECIPIENT = 'support@example.test';
const SMTP_ENV = {
  FEEDBACK_ENABLED: 'true',
  FEEDBACK_TO: FEEDBACK_RECIPIENT,
  SMTP_HOST: 'mail.example.test',
  SMTP_FROM: 'reports@example.test',
};

describe('feedback mail configuration', () => {
  it('is disabled by default and does not require SMTP credentials when disabled', () => {
    expect(loadFeedbackConfig({})).toBeNull();
    expect(loadFeedbackConfig({ FEEDBACK_ENABLED: 'false', SMTP_PORT: 'bad' })).toBeNull();
  });

  it('defaults enabled SMTP to STARTTLS on port 587', () => {
    expect(loadFeedbackConfig(SMTP_ENV)).toEqual({
      to: FEEDBACK_RECIPIENT,
      host: 'mail.example.test',
      from: 'reports@example.test',
      port: 587,
      secure: false,
      user: undefined,
      password: undefined,
    });
  });

  it.each([
    { ...SMTP_ENV, FEEDBACK_ENABLED: 'yes' },
    { ...SMTP_ENV, SMTP_HOST: '' },
    { ...SMTP_ENV, SMTP_PORT: '0' },
    { ...SMTP_ENV, SMTP_PORT: '65536' },
    { ...SMTP_ENV, SMTP_SECURE: 'yes' },
    { ...SMTP_ENV, SMTP_FROM: 'invalid' },
    { ...SMTP_ENV, FEEDBACK_TO: undefined },
    { ...SMTP_ENV, FEEDBACK_TO: 'invalid' },
    { ...SMTP_ENV, FEEDBACK_TO: 'support@example.test,other@example.test' },
    { ...SMTP_ENV, SMTP_USER: 'smtp-user' },
    { ...SMTP_ENV, SMTP_PASSWORD: 'never-expose-this-secret' },
  ])('rejects an incomplete or invalid SMTP setup without echoing secrets', (env) => {
    expect(() => loadFeedbackConfig(env)).toThrow();
    try {
      loadFeedbackConfig(env);
    } catch (err) {
      expect(String(err)).not.toContain('never-expose-this-secret');
      expect(String(err)).not.toContain('smtp-user');
    }
  });

  it('accepts paired SMTP credentials and explicit secure port', () => {
    expect(
      loadFeedbackConfig({
        ...SMTP_ENV,
        SMTP_PORT: '465',
        SMTP_SECURE: 'true',
        SMTP_USER: 'mailer',
        SMTP_PASSWORD: 'secret',
      }),
    ).toMatchObject({
      port: 465,
      secure: true,
      user: 'mailer',
      password: 'secret',
    });
  });
});

describe('feedback SMTP submission', () => {
  beforeEach(() => {
    smtp.sendMail.mockReset();
    smtp.createTransport.mockReset().mockReturnValue({ sendMail: smtp.sendMail });
  });

  it('sends only to the configured support address, with identity and plain text context', async () => {
    smtp.sendMail.mockResolvedValue({ accepted: [FEEDBACK_RECIPIENT], rejected: [] });
    const send = createFeedbackSender({
      to: FEEDBACK_RECIPIENT,
      host: 'smtp.example.test',
      port: 587,
      secure: false,
      from: 'reports@example.test',
      user: 'mailer',
      password: 'smtp-secret',
    });
    const id = await send({
      subject: 'Ошибка отчета',
      message: 'Первая строка\nВторая строка',
      replyTo: 'author@example.test',
      page: '/reports',
      login: 'ivan',
      userId: 'u1',
    });

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(smtp.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'smtp.example.test',
        port: 587,
        secure: false,
        requireTLS: true,
        auth: { user: 'mailer', pass: 'smtp-secret' },
        disableFileAccess: true,
        disableUrlAccess: true,
        logger: false,
        debug: false,
      }),
    );
    const [mail] = smtp.sendMail.mock.calls[0]!;
    expect(mail).toMatchObject({
      from: { name: 'Carbone Reports', address: 'reports@example.test' },
      to: FEEDBACK_RECIPIENT,
      replyTo: { address: 'author@example.test' },
      subject: '[Carbone Reports] Ошибка отчета',
    });
    expect(mail.text).toContain(`Обращение: ${id}`);
    expect(mail.text).toContain('Пользователь: ivan');
    expect(mail.text).toContain('ID пользователя: u1');
    expect(mail.text).toContain('Страница: /reports');
    expect(mail.text).toContain('Первая строка\nВторая строка');
    expect(mail).not.toHaveProperty('html');
    expect(mail).not.toHaveProperty('attachments');
  });

  it.each([
    { accepted: [], rejected: [FEEDBACK_RECIPIENT] },
    { accepted: ['other@example.test'], rejected: [] },
    { accepted: [FEEDBACK_RECIPIENT], rejected: ['other@example.test'] },
  ])('does not acknowledge a message the intended recipient did not accept', async (response) => {
    smtp.sendMail.mockResolvedValue(response);
    const send = createFeedbackSender({
      to: FEEDBACK_RECIPIENT,
      host: 'smtp.example.test',
      port: 465,
      secure: true,
      from: 'reports@example.test',
    });
    await expect(
      send({ subject: 'Help', message: 'Help', page: '/', login: 'ivan', userId: 'u1' }),
    ).rejects.toThrow('SMTP did not accept');
  });
});
