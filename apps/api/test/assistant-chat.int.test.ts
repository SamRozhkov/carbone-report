import type { TemplateParam } from '@carbone-reports/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CarboneRenderer } from '../src/deps';
import { fakeLlm } from './fake-llm';
import {
  createSourceDatabase,
  createTestApp,
  loginAs,
  openTemplate,
  type TestApp,
} from './helpers';

// POST /api/assistant/chat (§50.3) против поддельного OpenAI: цикл, инструменты от имени
// пользователя, граница данных (§50.1), ошибки провайдера и лимиты.

let t: TestApp;
let admin: string;
let user: string;
let tplA: string;
let tplB: string;

const carbone: CarboneRenderer = {
  async render(_tpl, data) {
    return Buffer.from(JSON.stringify(data));
  },
};

const COMPANY_SQL = 'select id as value, name as label from company order by id';

const param = (over: Partial<TemplateParam> & Pick<TemplateParam, 'name'>): TemplateParam => ({
  label: over.name,
  type: 'query',
  required: false,
  defaultValue: null,
  options: null,
  sql: null,
  multiple: false,
  ...over,
});

/** Шаблон с заданным названием и параметрами; open — доступен всем пользователям. */
async function createTpl(
  name: string,
  dsId: string,
  params: TemplateParam[],
  open: boolean,
): Promise<string> {
  const r = await t.app.inject({
    method: 'POST',
    url: '/api/templates',
    headers: { cookie: admin },
    payload: { name, datasourceId: dsId, blank: 'docx' },
  });
  expect(r.statusCode, r.body).toBe(201);
  const id = r.json().id as string;
  if (open) await openTemplate(t, id);
  const p = await t.app.inject({
    method: 'PUT',
    url: `/api/templates/${id}/params`,
    headers: { cookie: admin },
    payload: params,
  });
  expect(p.statusCode, p.body).toBe(200);
  return id;
}

const chat = (cookie: string, messages = [{ role: 'user', content: 'счёт для Лютика' }]) =>
  t.app.inject({
    method: 'POST',
    url: '/api/assistant/chat',
    headers: { cookie },
    payload: { messages, page: { path: '/reports' } },
  });

async function enable(url: string) {
  const r = await t.app.inject({
    method: 'PUT',
    url: '/api/admin/assistant',
    headers: { cookie: admin },
    payload: { enabled: true, baseUrl: url, model: 'm', apiKey: 'k', extraInstructions: '' },
  });
  expect(r.statusCode, r.body).toBe(204);
}

const toolCall = (name: string, args: object) => ({
  content: null,
  tool_calls: [{ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

/** Последнее сообщение запроса к модели — результат последнего инструмента. */
const lastMessage = (body: { messages: unknown[] }) => JSON.stringify(body.messages.at(-1));

beforeAll(async () => {
  t = await createTestApp({ carbone });
  admin = (await loginAs(t, 'admin')).cookie;
  user = (await loginAs(t, 'user')).cookie;
  const src = await createSourceDatabase(`
    create table company(id int, name text);
    insert into company values (1, 'ООО Ромашка'), (2, 'АО Лютик');
  `);
  const ds = await t.app.inject({
    method: 'POST',
    url: '/api/datasources',
    headers: { cookie: admin },
    payload: { name: 'firms', ...src, sslMode: 'disable' },
  });
  expect(ds.statusCode, ds.body).toBe(201);
  const dsId = ds.json().id as string;
  tplA = await createTpl(
    'Счёт',
    dsId,
    [
      param({ name: 'company', required: true, sql: COMPANY_SQL }),
      param({ name: 'paid', type: 'boolean' }),
    ],
    true,
  );
  tplB = await createTpl('Зарплаты', dsId, [param({ name: 'company', sql: COMPANY_SQL })], false);
  // Шаблон B действительно закрыт для пользователя — иначе сценарии ниже ничего не проверяют.
  const b = await t.app.inject({
    method: 'GET',
    url: `/api/templates/${tplB}`,
    headers: { cookie: user },
  });
  expect([403, 404]).toContain(b.statusCode);
});
afterAll(() => t.close());

describe('POST /api/assistant/chat', () => {
  it('выключен — 404', async () => {
    expect((await chat(user)).statusCode).toBe(404);
  });

  it('полный сценарий: список → форма → значения → карточка с подписями', async () => {
    const seen: string[] = [];
    let step = 0;
    const llm = await fakeLlm((body) => {
      seen.push(lastMessage(body));
      const steps = [
        // Без поиска: шаблон B отсекается правами, а не фильтром.
        toolCall('list_reports', {}),
        toolCall('get_report_form', { reportId: tplA }),
        toolCall('find_param_values', { reportId: tplA, param: 'company', search: 'лютик' }),
        toolCall('propose_run', { reportId: tplA, params: { company: 2, paid: true } }),
      ];
      return { message: steps[step++] ?? { content: 'конец' } };
    });
    await enable(llm.url);
    const r = await chat(user);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().card).toMatchObject({
      reportId: tplA,
      reportName: 'Счёт',
      params: { company: 2, paid: true },
      display: [
        { label: 'company', value: 'АО Лютик' },
        { label: 'paid', value: 'да' },
      ],
    });
    // Модель получила список, форму и найденное значение…
    expect(seen[1]).toContain('Счёт');
    expect(seen[2]).toContain('find_param_values');
    expect(seen[3]).toContain('АО Лютик');
    expect(seen[3]).not.toContain('Ромашка');
    // …но не SQL и не шаблон B.
    const all = seen.join('\n');
    expect(all).not.toContain('select id as value');
    expect(all).not.toContain('Зарплаты');
    expect(llm.auth.every((a) => a === 'Bearer k')).toBe(true);
    await llm.close();
  });

  it('шаблон без доступа: форма и карточка — ошибка, а не данные', async () => {
    let step = 0;
    const toolResults: string[] = [];
    const llm = await fakeLlm((body) => {
      toolResults.push(lastMessage(body));
      const steps = [
        toolCall('get_report_form', { reportId: tplB }),
        toolCall('propose_run', { reportId: tplB, params: {} }),
      ];
      return { message: steps[step++] ?? { content: 'нет доступа' } };
    });
    await enable(llm.url);
    const r = await chat(user);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ reply: 'нет доступа', card: null });
    expect(toolResults[1]).toContain('error');
    expect(toolResults[2]).toContain('error');
    expect(toolResults.join('\n')).not.toContain('Зарплаты');
    await llm.close();
  });

  it('неверные параметры, объект в значении, неизвестный инструмент — ошибка модели, затем вопрос', async () => {
    let step = 0;
    const toolResults: string[] = [];
    const llm = await fakeLlm((body) => {
      toolResults.push(lastMessage(body));
      const steps = [
        toolCall('propose_run', { reportId: tplA, params: { company: 999 } }),
        toolCall('propose_run', { reportId: tplA, params: { company: { x: 1 } } }),
        toolCall('nonexistent_tool', {}),
        toolCall('toString', {}),
      ];
      return { message: steps[step++] ?? { content: 'Какая компания?' } };
    });
    await enable(llm.url);
    const r = await chat(user);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ reply: 'Какая компания?', card: null });
    expect(toolResults).toHaveLength(5);
    for (const res of toolResults.slice(1)) expect(res).toContain('error');
    expect(toolResults[2]).toContain('invalid params');
    expect(toolResults[3]).toContain('unknown tool: nonexistent_tool');
    expect(toolResults[4]).toContain('unknown tool: toString');
    await llm.close();
  });

  it('ошибка провайдера: 502 с кодом и текстом, без ключа в ответе', async () => {
    const llm = await fakeLlm(() => ({ status: 401 }));
    await enable(llm.url);
    const r = await chat(user);
    expect(r.statusCode).toBe(502);
    expect(r.json().error.code).toBe('ASSISTANT_AUTH');
    expect(r.json().error.message).toBeTruthy();
    expect(r.body).not.toContain('Bearer');
    await llm.close();
  });

  it('модель зациклилась — 422 ASSISTANT_LIMIT', async () => {
    const llm = await fakeLlm(() => ({ message: toolCall('list_reports', {}) }));
    await enable(llm.url);
    const r = await chat(user);
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('ASSISTANT_LIMIT');
    await llm.close();
  });

  it('не больше 20 запросов в минуту на пользователя', async () => {
    const r0 = await t.app.inject({
      method: 'PUT',
      url: '/api/admin/assistant',
      headers: { cookie: admin },
      payload: {
        enabled: false,
        baseUrl: 'http://127.0.0.1:9/v1',
        model: 'm',
        extraInstructions: '',
      },
    });
    expect(r0.statusCode, r0.body).toBe(204);
    const fresh = (await loginAs(t, 'user')).cookie;
    for (let i = 0; i < 20; i++) expect((await chat(fresh)).statusCode).toBe(404);
    const over = await chat(fresh);
    expect(over.statusCode, over.body).toBe(429);
    expect(over.json().error.code).toBe('TOO_MANY_ATTEMPTS');
    expect(over.json().error.message).toContain('ассистент');
    // Счётчик — свой у каждого пользователя.
    expect((await chat((await loginAs(t, 'user')).cookie)).statusCode).toBe(404);
  });

  it('без входа — 401', async () => {
    expect((await chat('')).statusCode).toBe(401);
  });
});
