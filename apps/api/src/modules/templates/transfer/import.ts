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
import type { TemplateParam } from '@carbone-reports/shared';
import { asc, desc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import {
  categories,
  datasources,
  groups,
  templateGroups,
  templateParams,
  templateQueries,
  templates,
} from '../../../db/schema';
import type { AppDeps } from '../../../deps';
import { AppError, badRequest, conflict } from '../../../lib/errors';
import { orderParams } from '../../queries/param-deps';
import { checkParamDefaults } from '../../queries/params';
import { discardUncommittedFile, templateDir, templateFilePath } from '../service';
import { importInvalid, readTransferArchive } from './archive';

export type ImportDeps = Pick<AppDeps, 'db' | 'storage'>;

type Log = { warn: (obj: object, msg: string) => void };

const toTemplateParam = ({ sortOrder: _, ...p }: TransferParam): TemplateParam => p;

/** Те же проверки параметров, что у `PUT /api/templates/:id/params`: граф ссылок и значения по умолчанию. */
export function paramErrors(params: TransferParam[]): string[] {
  const defs = params.map(toTemplateParam);
  const out: string[] = [];
  for (const check of [orderParams, checkParamDefaults]) {
    try {
      check(defs);
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      const d = err.details as
        { path: string; message: string }[] | { fields: Record<string, string> } | undefined;
      if (Array.isArray(d)) {
        for (const x of d) {
          const i = Number(x.path.split('/')[1]);
          out.push(`параметр «${defs[i]?.name ?? i}»: ${x.message}`);
        }
      } else if (d?.fields) {
        for (const [name, msg] of Object.entries(d.fields)) out.push(`параметр «${name}»: ${msg}`);
      } else {
        out.push(err.message);
      }
    }
  }
  return out;
}

/** Что уже есть в этой среде — для сопоставления по именам. */
export interface ImportLookup {
  /** Шаблоны по точному имени; изменённые последними — первыми. */
  templatesByName: Map<string, ImportExisting[]>;
  /** id источников по точному имени. */
  datasourcesByName: Map<string, string[]>;
  /** id групп по имени в нижнем регистре (имена групп уникальны без учёта регистра). */
  groupsByLower: Map<string, string>;
  /** id категорий по имени в нижнем регистре. */
  categoriesByLower: Map<string, string>;
}

/** План (предпросмотр) — чистая функция от манифеста и того, что есть в среде. */
export function planImport(manifest: TransferManifest, lookup: ImportLookup): ImportPreviewItem[] {
  return manifest.templates.map((t, index) => {
    const sameName = lookup.templatesByName.get(t.name) ?? [];
    const ds = lookup.datasourcesByName.get(t.datasource.name) ?? [];
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
      categoryExists: t.category === null || lookup.categoriesByLower.has(t.category.toLowerCase()),
      groups: t.groups,
      missingGroups: t.groups.filter((g) => !lookup.groupsByLower.has(g.toLowerCase())),
      errors: paramErrors(t.params),
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
  conflict(`шаблон «${name}» изменился после предпросмотра — повторите предпросмотр`);

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
    if (d.index >= plan.length) throw badRequest(`в архиве нет шаблона с номером ${d.index}`);
    if (byIndex.has(d.index)) throw badRequest(`решение для шаблона ${d.index} повторяется`);
    byIndex.set(d.index, d);
  }
  const taken = new Set(ctx.takenNames);
  const updated = new Set<string>();
  return plan.map((item) => {
    const d = byIndex.get(item.index);
    const who = `шаблон «${item.name}»`;
    if (!d) throw badRequest(`${who}: не выбрано действие`);
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
    if (item.errors.length) throw importInvalid(`${who}: ${item.errors[0]}`);
    if (!d.datasourceId) throw badRequest(`${who}: выберите источник данных`);
    if (!ctx.datasourceIds.has(d.datasourceId))
      throw conflict(`${who}: источник данных не найден — повторите предпросмотр`);
    let name = item.name;
    let targetId: string | null = null;
    if (d.action === 'create') {
      if (taken.has(name)) {
        // Предпросмотр предлагает «создать» только при свободном имени: шаблон появился после него.
        throw conflict(
          `${who} уже есть — повторите предпросмотр и выберите «обновить», «копия» или «пропустить»`,
        );
      }
    } else if (d.action === 'copy') {
      name = copyName(item.name, taken);
    } else {
      if (!d.targetId) throw badRequest(`${who}: укажите обновляемый шаблон`);
      if (!d.targetUpdatedAt) throw badRequest(`${who}: укажите время изменения из предпросмотра`);
      const target = item.existing.find((e) => e.id === d.targetId);
      // Удалён, переименован или изменён (файл, запросы, параметры, доступ) после предпросмотра.
      if (target?.updatedAt !== d.targetUpdatedAt) throw changedSincePreview(item.name);
      if (updated.has(d.targetId)) throw badRequest(`${who} обновляется дважды`);
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

async function loadLookup(deps: ImportDeps, manifest: TransferManifest): Promise<ImportLookup> {
  const { db } = deps;
  const ts = manifest.templates;
  const lower = (xs: string[]) => [...new Set(xs.map((x) => x.toLowerCase()))];
  const groupNames = lower(ts.flatMap((t) => t.groups));
  const categoryNames = lower(ts.flatMap((t) => (t.category === null ? [] : [t.category])));
  const [tpl, ds, gs, cs] = await Promise.all([
    db
      .select({ id: templates.id, name: templates.name, updatedAt: updatedAtText })
      .from(templates)
      .where(inArray(templates.name, [...new Set(ts.map((t) => t.name))]))
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
    const e = { id: r.id, name: r.name, updatedAt: r.updatedAt };
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
export async function previewImport(deps: ImportDeps, zip: Buffer): Promise<ImportPreview> {
  const { manifest } = await readTransferArchive(zip);
  return {
    appVersion: manifest.appVersion,
    exportedAt: manifest.exportedAt,
    templates: planImport(manifest, await loadLookup(deps, manifest)),
  };
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
  userId: string,
  log?: Log,
): Promise<ImportResult> {
  const { db, storage } = deps;
  const { manifest, files } = await readTransferArchive(zip);
  const lookup = await loadLookup(deps, manifest);
  const plan = planImport(manifest, lookup);

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
              .select({ ...getTableColumns(templates), updatedAtText })
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
        if (cur?.name !== r.name || cur.updatedAtText !== r.targetUpdatedAt)
          throw changedSincePreview(r.name);
      }
      // Имена — заново: между ранней проверкой и блокировкой могла пройти другая загрузка.
      const names = await tx.select({ name: templates.name }).from(templates);
      resolved = resolveDecisions(plan, decisions, {
        datasourceIds,
        takenNames: new Set(names.map((r) => r.name)),
      });
      const work = resolved.filter((r) => r.action !== 'skip');

      // Категории — по имени без учёта регистра; недостающие создаются один раз.
      const categoryIds = new Map(lookup.categoriesByLower);
      for (const r of work) {
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
          categoryId: t.category === null ? null : categoryIds.get(t.category.toLowerCase())!,
          docKey: randomUUID(),
          updatedAt: new Date(),
          updatedBy: userId,
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
            })
            .where(eq(templates.id, id));
          await tx.delete(templateGroups).where(eq(templateGroups.templateId, id));
          await tx.delete(templateQueries).where(eq(templateQueries.templateId, id));
          await tx.delete(templateParams).where(eq(templateParams.templateId, id));
        } else {
          id = randomUUID();
          const path = templateFilePath(id, t.fileExt, 1);
          created.push(id);
          await storage.write(path, data);
          await tx.insert(templates).values({ ...meta, id, name: r.name, filePath: path });
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
      ...updatedFiles.map(({ id, path }) =>
        discardUncommittedFile(deps, id, path).catch((e) =>
          log?.warn({ err: e, filePath: path }, 'несохранённый файл шаблона не удалён'),
        ),
      ),
    ]);
    if (isConcurrentChange(err)) {
      throw conflict(
        'данные изменились во время загрузки (источник, группа или категория) — повторите предпросмотр',
      );
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
