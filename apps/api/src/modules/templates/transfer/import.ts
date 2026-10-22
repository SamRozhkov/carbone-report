import { randomUUID } from 'node:crypto';
import type {
  ImportAction,
  ImportDecision,
  ImportExisting,
  ImportPreview,
  ImportPreviewItem,
  ImportResult,
  TransferManifest,
  TransferParam,
  TransferTemplate,
} from '@carbone-reports/shared/template-transfer';
import { normalizePdfOptions, type TemplateParam } from '@carbone-reports/shared';
import { and, asc, desc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import {
  categories,
  datasources,
  groups,
  templateAttachments,
  templateCharts,
  templateEditLocks,
  templateGroups,
  templateParams,
  templateQueries,
  templates,
  users,
} from '../../../db/schema';
import type { AppDeps } from '../../../deps';
import type { Locale } from '@carbone-reports/shared/i18n';
import { AppError, badRequest, conflict, forbidden, translateMsg } from '../../../lib/errors';
import type { SessionUser } from '../../auth/session';
import { editableTemplates, NO_EDIT_RIGHT } from '../../access/permissions';
import { activeLock, lockAlive } from '../../edit-lock/service';
import { orderParams } from '../../queries/param-deps';
import { checkParamDefaults } from '../../queries/params';
import {
  discardUncommittedFile,
  templateAttachmentPath,
  templateDir,
  templateFilePath,
} from '../service';
import { importInvalid, readTransferArchive } from './archive';

export type ImportDeps = Pick<AppDeps, 'db' | 'storage'>;

type Log = { warn: (obj: object, msg: string) => void };

const toTemplateParam = ({ sortOrder: _, ...p }: TransferParam): TemplateParam => p;

/**
 * Те же проверки параметров, что у `PUT /api/templates/:id/params`: граф ссылок и значения по
 * умолчанию. Тексты — на языке locale (идут в ответ предпросмотра).
 */
export function paramErrors(params: TransferParam[], locale: Locale = 'ru'): string[] {
  const defs = params.map(toTemplateParam);
  const out: string[] = [];
  for (const check of [orderParams, checkParamDefaults]) {
    try {
      check(defs);
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      const d = err.detailsIn(locale) as
        { path: string; message: string }[] | { fields: Record<string, string> } | undefined;
      const paramError = (name: string | number, message: string) =>
        translateMsg(locale, { key: 'import.paramError', params: { name, message } });
      if (Array.isArray(d)) {
        for (const x of d) {
          const i = Number(x.path.split('/')[1]);
          out.push(paramError(defs[i]?.name ?? i, x.message));
        }
      } else if (d?.fields) {
        for (const [name, msg] of Object.entries(d.fields)) out.push(paramError(name, msg));
      } else {
        out.push(err.textIn(locale));
      }
    }
  }
  return out;
}

/** Что уже есть в этой среде — для сопоставления по именам. */
export interface ImportLookup {
  /** Шаблоны по точному имени, которые загружающий может править; изменённые последними — первыми. */
  templatesByName: Map<string, ImportExisting[]>;
  /** id источников по точному имени. */
  datasourcesByName: Map<string, string[]>;
  /** id групп по имени в нижнем регистре (имена групп уникальны без учёта регистра). */
  groupsByLower: Map<string, string>;
  /** id категорий по имени в нижнем регистре. */
  categoriesByLower: Map<string, string>;
}

/** План (предпросмотр) — чистая функция от манифеста и того, что есть в среде. */
export function planImport(
  manifest: TransferManifest,
  lookup: ImportLookup,
  actor: Pick<SessionUser, 'role'>,
  locale: Locale = 'ru',
): ImportPreviewItem[] {
  return manifest.templates.map((t, index) => {
    const sameName = lookup.templatesByName.get(t.name) ?? [];
    const ds = lookup.datasourcesByName.get(t.datasource.name) ?? [];
    const categoryExists =
      t.category === null || lookup.categoriesByLower.has(t.category.toLowerCase());
    return {
      index,
      name: t.name,
      description: t.description,
      fileExt: t.fileExt,
      existing: sameName,
      datasource: t.datasource,
      // Несколько источников с одним именем — неоднозначно: пусть выберет администратор.
      datasourceMatch: ds.length === 1 ? ds[0]! : null,
      category: t.category,
      categoryExists,
      // Категории создаёт только администратор (§43.3).
      categorySkipped: actor.role !== 'admin' && !categoryExists,
      groups: t.groups,
      missingGroups: t.groups.filter((g) => !lookup.groupsByLower.has(g.toLowerCase())),
      errors: paramErrors(t.params, locale),
      pdfPasswordSet: t.pdfPasswordSet ?? false,
    };
  });
}

/** «<имя> (N)» с первым свободным N ≥ 2. */
export function copyName(name: string, taken: Set<string>): string {
  for (let n = 2; ; n++) {
    const candidate = `${name} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
}

export interface ResolvedDecision {
  index: number;
  action: ImportAction;
  /** Итоговое имя шаблона. */
  name: string;
  datasourceId: string | null;
  /** Обновляемый шаблон (`update`). */
  targetId: string | null;
  /** `updatedAt` обновляемого шаблона, как его видел администратор в предпросмотре. */
  targetUpdatedAt: string | null;
}

/**
 * Время изменения шаблона текстом с микросекундами (точность timestamptz): Date в JS хранит только
 * миллисекунды, и два изменения в одну миллисекунду были бы неразличимы.
 */
export const updatedAtText = sql<string>`to_char(${templates.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export const changedSincePreview = (name: string) =>
  conflict('import.changedSincePreview', { name });

/**
 * Проверка решений администратора по плану: ровно одно решение на шаблон архива, источник
 * для всех, кроме `skip`; `create` — только при свободном имени, `update` — только шаблона
 * из `existing` (иначе 409: после предпросмотра его удалили или переименовали).
 * `takenNames` — имена всех шаблонов среды; дополняется именами создаваемых.
 */
export function resolveDecisions(
  plan: ImportPreviewItem[],
  decisions: ImportDecision[],
  ctx: { datasourceIds: Set<string>; takenNames: Set<string> },
): ResolvedDecision[] {
  const byIndex = new Map<number, ImportDecision>();
  for (const d of decisions) {
    if (d.index >= plan.length) throw badRequest('import.noTemplateIndex', { index: d.index });
    if (byIndex.has(d.index)) throw badRequest('import.decisionDuplicate', { index: d.index });
    byIndex.set(d.index, d);
  }
  const taken = new Set(ctx.takenNames);
  const updated = new Set<string>();
  return plan.map((item) => {
    const d = byIndex.get(item.index);
    const template = item.name;
    if (!d) throw badRequest('import.noAction', { template });
    if (d.action === 'skip') {
      return {
        index: item.index,
        action: 'skip',
        name: item.name,
        datasourceId: null,
        targetId: null,
        targetUpdatedAt: null,
      };
    }
    if (item.errors.length)
      throw importInvalid('import.templateError', { template, message: item.errors[0]! });
    if (!d.datasourceId) throw badRequest('import.datasourceRequired', { template });
    if (!ctx.datasourceIds.has(d.datasourceId))
      throw conflict('import.datasourceGone', { template });
    let name = item.name;
    let targetId: string | null = null;
    if (d.action === 'create') {
      if (taken.has(name)) {
        // Предпросмотр предлагает «создать» только при свободном имени: шаблон появился после него.
        throw conflict('import.nameTaken', { template });
      }
    } else if (d.action === 'copy') {
      name = copyName(item.name, taken);
    } else {
      if (!d.targetId) throw badRequest('import.targetRequired', { template });
      if (!d.targetUpdatedAt) throw badRequest('import.targetUpdatedAtRequired', { template });
      const target = item.existing.find((e) => e.id === d.targetId);
      // Удалён, переименован или изменён (файл, запросы, параметры, доступ) после предпросмотра.
      if (target?.updatedAt !== d.targetUpdatedAt) throw changedSincePreview(item.name);
      if (updated.has(d.targetId)) throw badRequest('import.updatedTwice', { template });
      updated.add(d.targetId);
      targetId = d.targetId;
    }
    taken.add(name);
    return {
      index: item.index,
      action: d.action,
      name,
      datasourceId: d.datasourceId,
      targetId,
      targetUpdatedAt: targetId ? d.targetUpdatedAt! : null,
    };
  });
}

async function loadLookup(
  deps: ImportDeps,
  manifest: TransferManifest,
  actor: SessionUser,
): Promise<ImportLookup> {
  const { db } = deps;
  const ts = manifest.templates;
  const lower = (xs: string[]) => [...new Set(xs.map((x) => x.toLowerCase()))];
  const groupNames = lower(ts.flatMap((t) => t.groups));
  const categoryNames = lower(ts.flatMap((t) => (t.category === null ? [] : [t.category])));
  const [tpl, ds, gs, cs] = await Promise.all([
    db
      .select({
        id: templates.id,
        name: templates.name,
        updatedAt: updatedAtText,
        lockLogin: users.login,
      })
      .from(templates)
      .leftJoin(templateEditLocks, and(eq(templateEditLocks.templateId, templates.id), lockAlive))
      .leftJoin(users, eq(users.id, templateEditLocks.userId))
      // Кандидаты на «обновить» — только шаблоны, которые загружающий может править (§43.3).
      .where(
        and(inArray(templates.name, [...new Set(ts.map((t) => t.name))]), editableTemplates(actor)),
      )
      .orderBy(desc(templates.updatedAt), templates.id),
    db
      .select({ id: datasources.id, name: datasources.name })
      .from(datasources)
      .where(inArray(datasources.name, [...new Set(ts.map((t) => t.datasource.name))])),
    groupNames.length
      ? db
          .select({ id: groups.id, name: groups.name })
          .from(groups)
          .where(inArray(sql`lower(${groups.name})`, groupNames))
      : [],
    categoryNames.length
      ? db
          .select({ id: categories.id, name: categories.name })
          .from(categories)
          .where(inArray(sql`lower(${categories.name})`, categoryNames))
      : [],
  ]);
  const templatesByName = new Map<string, ImportExisting[]>();
  for (const r of tpl) {
    const e = {
      id: r.id,
      name: r.name,
      updatedAt: r.updatedAt,
      lockedBy: r.lockLogin ? { login: r.lockLogin } : null,
    };
    templatesByName.set(r.name, [...(templatesByName.get(r.name) ?? []), e]);
  }
  const datasourcesByName = new Map<string, string[]>();
  for (const r of ds)
    datasourcesByName.set(r.name, [...(datasourcesByName.get(r.name) ?? []), r.id]);
  return {
    templatesByName,
    datasourcesByName,
    groupsByLower: new Map(gs.map((g) => [g.name.toLowerCase(), g.id])),
    categoriesByLower: new Map(cs.map((c) => [c.name.toLowerCase(), c.id])),
  };
}

/** Предпросмотр загрузки (§33.2): ничего не меняет. */
export async function previewImport(
  deps: ImportDeps,
  zip: Buffer,
  actor: SessionUser,
  locale: Locale = 'ru',
): Promise<ImportPreview> {
  const { manifest } = await readTransferArchive(zip);
  return {
    appVersion: manifest.appVersion,
    exportedAt: manifest.exportedAt,
    templates: planImport(manifest, await loadLookup(deps, manifest, actor), actor, locale),
  };
}

/**
 * Каждый обновляемый шаблон загружающий может править (§43.3); иначе — 403, в том числе для
 * несуществующего id (не отличаем чужой от отсутствующего). Админ правит любой.
 */
async function assertUpdateTargets(
  deps: ImportDeps,
  decisions: ImportDecision[],
  actor: SessionUser,
): Promise<void> {
  if (actor.role === 'admin') return;
  const ids = [
    ...new Set(decisions.flatMap((d) => (d.action === 'update' && d.targetId ? [d.targetId] : []))),
  ];
  if (!ids.length) return;
  const rows = await deps.db
    .select({ id: templates.id })
    .from(templates)
    .where(and(inArray(templates.id, ids), editableTemplates(actor)));
  if (rows.length !== ids.length) throw forbidden(NO_EDIT_RIGHT);
}

/** Загрузки архивов выполняются по одной: имена создаваемых шаблонов проверяются под этой блокировкой. */
export const IMPORT_LOCK_KEY = 726100004;

/**
 * Гонки с параллельными изменениями: уникальность (категория создана одновременно), внешний ключ
 * (источник, группа или категория удалены после проверки), взаимоблокировка.
 */
const isConcurrentChange = (err: unknown) => {
  const e = err as { code?: string; cause?: { code?: string } };
  const code = e.cause?.code ?? e.code;
  return code === '23505' || code === '23503' || code === '40P01';
};

/**
 * Загрузка (§33.2): все шаблоны — в одной транзакции. Файлы пишутся в хранилище до её фиксации
 * (у обновляемого — под блокировкой строки, как при ручной замене файла) и удаляются при откате.
 */
export async function applyImport(
  deps: ImportDeps,
  zip: Buffer,
  decisions: ImportDecision[],
  actor: SessionUser,
  log?: Log,
  /** Язык текстов ошибок параметров, которые входят в ошибку загрузки. */
  locale: Locale = 'ru',
): Promise<ImportResult> {
  const { db, storage } = deps;
  const { manifest, files, attachments } = await readTransferArchive(zip);
  // До записи файлов; иначе чужой шаблон не попал бы в `existing` и отказ был бы 409.
  await assertUpdateTargets(deps, decisions, actor);
  const lookup = await loadLookup(deps, manifest, actor);
  const plan = planImport(manifest, lookup, actor, locale);

  const wantedDs = [...new Set(decisions.flatMap((d) => (d.datasourceId ? [d.datasourceId] : [])))];
  const [dsRows, nameRows] = await Promise.all([
    wantedDs.length
      ? db.select({ id: datasources.id }).from(datasources).where(inArray(datasources.id, wantedDs))
      : [],
    db.select({ name: templates.name }).from(templates),
  ]);
  const datasourceIds = new Set(dsRows.map((r) => r.id));
  // Ранняя проверка — до записи файлов; окончательная — в транзакции под блокировкой загрузок.
  let resolved = resolveDecisions(plan, decisions, {
    datasourceIds,
    takenNames: new Set(nameRows.map((r) => r.name)),
  });
  if (resolved.every((r) => r.action === 'skip')) {
    return { templates: resolved.map((r) => ({ ...result(r), id: null })) };
  }

  const created: string[] = [];
  const updatedFiles: { id: string; path: string }[] = [];
  const previous: string[] = [];
  const ids = new Map<number, string>();
  const writtenAttachments: string[] = [];
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${IMPORT_LOCK_KEY})`);
      // Обновляемые — под блокировкой строк (одним запросом, по порядку id — без взаимоблокировок
      // между загрузками и с callback OnlyOffice): шаблон на месте, имя то же, что в архиве, и не
      // менялся с предпросмотра (updated_at с точностью до микросекунды).
      const targetIds = resolved.flatMap((r) => (r.targetId ? [r.targetId] : []));
      const locked = new Map(
        (targetIds.length
          ? await tx
              .select({
                ...getTableColumns(templates),
                updatedAtText,
                // Владелец и редакторы могли смениться после ранней проверки (§43.3).
                editable: sql<boolean>`${editableTemplates(actor) ?? sql`true`}`,
              })
              .from(templates)
              .where(inArray(templates.id, targetIds))
              .orderBy(asc(templates.id))
              .for('update')
          : []
        ).map((row) => [row.id, row]),
      );
      for (const r of resolved) {
        if (!r.targetId) continue;
        const cur = locked.get(r.targetId);
        if (cur && !cur.editable) throw forbidden(NO_EDIT_RIGHT);
        if (cur?.name !== r.name || cur.updatedAtText !== r.targetUpdatedAt)
          throw changedSincePreview(r.name);
      }
      // Обновляемый шаблон открыт в редакторе — не обновляется (§38.2).
      for (const r of resolved) {
        if (!r.targetId) continue;
        const lock = await activeLock(tx, r.targetId);
        if (lock) throw conflict('import.templateLocked', { template: r.name, login: lock.login });
      }
      // Имена — заново: между ранней проверкой и блокировкой могла пройти другая загрузка.
      const names = await tx.select({ name: templates.name }).from(templates);
      resolved = resolveDecisions(plan, decisions, {
        datasourceIds,
        takenNames: new Set(names.map((r) => r.name)),
      });
      const work = resolved.filter((r) => r.action !== 'skip');

      // Категории — по имени без учёта регистра; недостающие создаются один раз и только
      // администратором — у прочих шаблон загружается без категории (§43.3).
      const categoryIds = new Map(lookup.categoriesByLower);
      for (const r of actor.role === 'admin' ? work : []) {
        const cat = manifest.templates[r.index]!.category;
        if (cat === null || categoryIds.has(cat.toLowerCase())) continue;
        const [row] = await tx.insert(categories).values({ name: cat }).returning();
        categoryIds.set(cat.toLowerCase(), row!.id);
      }

      for (const r of work) {
        const t: TransferTemplate = manifest.templates[r.index]!;
        const data = files[r.index]!;
        const meta = {
          description: t.description,
          datasourceId: r.datasourceId!,
          fileExt: t.fileExt,
          defaultOutput: t.defaultOutput,
          public: t.public,
          categoryId:
            t.category === null ? null : (categoryIds.get(t.category.toLowerCase()) ?? null),
          pdfOptions: normalizePdfOptions(t.pdfOptions ?? { pdfa: false }),
          docKey: randomUUID(),
          updatedAt: new Date(),
          updatedBy: actor.id,
        };
        let id: string;
        if (r.targetId) {
          const cur = locked.get(r.targetId)!;
          id = cur.id;
          const path = templateFilePath(id, t.fileExt, cur.version + 1);
          updatedFiles.push({ id, path });
          await storage.write(path, data);
          previous.push(cur.filePath);
          await tx
            .update(templates)
            .set({
              ...meta,
              version: cur.version + 1,
              filePath: path,
              lastSaveError: null,
              lastSaveErrorAt: null,
              // Пароль не переносится (§37.4): с признаком в архиве остаётся пароль цели, без — снимается.
              ...(t.pdfPasswordSet ? {} : { pdfPasswordEnc: null }),
            })
            .where(eq(templates.id, id));
          await tx.delete(templateGroups).where(eq(templateGroups.templateId, id));
          // Графики заменяются вместе с запросами в одной транзакции: график не ссылается на чужой запрос.
          await tx.delete(templateCharts).where(eq(templateCharts.templateId, id));
          await tx.delete(templateQueries).where(eq(templateQueries.templateId, id));
          await tx.delete(templateParams).where(eq(templateParams.templateId, id));
          // Приложения заменяются целиком; прежние файлы удаляются после коммита.
          const old = await tx
            .delete(templateAttachments)
            .where(eq(templateAttachments.templateId, id))
            .returning({ filePath: templateAttachments.filePath });
          previous.push(...old.map((o) => o.filePath));
        } else {
          id = randomUUID();
          const path = templateFilePath(id, t.fileExt, 1);
          created.push(id);
          await storage.write(path, data);
          await tx
            .insert(templates)
            .values({ ...meta, id, name: r.name, filePath: path, ownerId: actor.id });
        }
        ids.set(r.index, id);

        const groupIds = t.groups.flatMap((g) => {
          const gid = lookup.groupsByLower.get(g.toLowerCase());
          return gid ? [gid] : [];
        });
        if (groupIds.length) {
          await tx
            .insert(templateGroups)
            .values(groupIds.map((groupId) => ({ templateId: id, groupId })));
        }
        if (t.queries.length) {
          await tx.insert(templateQueries).values(t.queries.map((q) => ({ ...q, templateId: id })));
        }
        if (t.params.length) {
          await tx.insert(templateParams).values(
            t.params.map((p) => ({
              ...toTemplateParam(p),
              sortOrder: p.sortOrder,
              templateId: id,
            })),
          );
        }
        if (t.charts?.length) {
          await tx.insert(templateCharts).values(
            t.charts.map((c) => ({
              templateId: id,
              key: c.key,
              sortOrder: c.sortOrder,
              config: c.config,
            })),
          );
        }
        const list = attachments[r.index] ?? [];
        for (const [n, a] of (t.attachments ?? []).entries()) {
          const file = list[n]!;
          const path = templateAttachmentPath(id, randomUUID());
          writtenAttachments.push(path);
          await storage.write(path, file.data);
          await tx.insert(templateAttachments).values({
            templateId: id,
            placement: a.placement,
            sortOrder: a.sortOrder,
            name: a.name,
            filePath: path,
            size: file.data.length,
            pages: file.pages,
            pdfa: file.pdfa,
          });
        }
      }
    });
  } catch (err) {
    // Откат. Коммит мог пройти, несмотря на ошибку (обрыв связи): каталоги созданных убираем,
    // только если строки нет; новые версии обновлённых — если строка на них не ссылается.
    let orphans: string[] = [];
    try {
      const kept = created.length
        ? await db
            .select({ id: templates.id })
            .from(templates)
            .where(inArray(templates.id, created))
        : [];
      orphans = created.filter((id) => !kept.some((k) => k.id === id));
    } catch (e) {
      log?.warn({ err: e, ids: created }, 'не удалось проверить шаблоны — файлы оставлены');
    }
    await Promise.all([
      ...orphans.map((id) =>
        storage
          .remove(templateDir(id))
          .catch((e) => log?.warn({ err: e, id }, 'файлы несохранённого шаблона не удалены')),
      ),
      (async () => {
        if (!writtenAttachments.length) return;
        const kept = await db
          .select({ filePath: templateAttachments.filePath })
          .from(templateAttachments)
          .where(inArray(templateAttachments.filePath, writtenAttachments))
          .catch((e) => {
            log?.warn({ err: e, files: writtenAttachments }, 'ошибка проверки приложений');
            return null;
          });
        if (!kept)
          return log?.warn(
            { files: writtenAttachments },
            'не удалось проверить приложения — файлы оставлены',
          );
        const keep = new Set(kept.map((k) => k.filePath));
        await Promise.all(
          writtenAttachments
            .filter((p) => !keep.has(p))
            .map((p) =>
              storage
                .remove(p)
                .catch((e) =>
                  log?.warn({ err: e, filePath: p }, 'несохранённое приложение не удалено'),
                ),
            ),
        );
      })(),
      ...updatedFiles.map(({ id, path }) =>
        discardUncommittedFile(deps, id, path).catch((e) =>
          log?.warn({ err: e, filePath: path }, 'несохранённый файл шаблона не удалён'),
        ),
      ),
    ]);
    if (isConcurrentChange(err)) {
      throw conflict('import.concurrentChange');
    }
    throw err;
  }
  // Прежние версии — в фоне: во время бэкапа удаление ждёт блокировку (§17.1).
  for (const p of previous) {
    void storage
      .remove(p)
      .catch((e) => log?.warn({ err: e, filePath: p }, 'старый файл шаблона не удалён'));
  }
  return { templates: resolved.map((r) => ({ ...result(r), id: ids.get(r.index) ?? null })) };
}

const result = (r: ResolvedDecision) => ({ index: r.index, action: r.action, name: r.name });
