import type {
  Card,
  DocSnapshot,
  EditorDraft,
  QueryMode,
  SheetSnapshot,
} from '@carbone-reports/shared';
import { TemplateParam } from '@carbone-reports/shared';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { DocumentAdapter } from './documentAdapter';
import type { SheetAdapter } from './sheetAdapter';

/** Мост панели ассистента и редактора шаблона (§51.5). */

export type ApplyCard = Extract<Card, { type: 'query' } | { type: 'param' }>;

export interface EditorRegistration {
  templateId: string;
  templateName: string;
  /** Расширение файла шаблона: по нему карточки выбирают формирование в документе или в листе
   *  (formingKind); не передано — текстовый шаблон, как до §53. */
  fileExt?: string;
  /** Сохранённые запросы и параметры — для вкладок, которые сейчас не открыты. */
  saved: () => EditorDraft;
  openTab: (tab: 'data' | 'params' | 'document') => void;
}

/** Открытый во вкладке «Документ» документ шаблона с connector OnlyOffice (§52.5). */
export interface DocumentRegistration {
  templateId: string;
  adapter: DocumentAdapter;
  /** Документ открыт на редактирование (блокировка §38 у этой вкладки). */
  editable: () => boolean;
}

/** Открытый во вкладке «Документ» лист шаблона xlsx/ods с connector OnlyOffice (§53.4). */
export interface SheetRegistration {
  templateId: string;
  adapter: SheetAdapter;
  /** Лист открыт на редактирование (блокировка §38 у этой вкладки). */
  editable: () => boolean;
}

/** Вид формирования шаблона по расширению файла: docx/odt — документ, xlsx/ods — лист, иное — нет. */
export function formingKind(fileExt: string | undefined): 'document' | 'sheet' | null {
  switch (fileExt) {
    case undefined:
    case 'docx':
    case 'odt':
      return 'document';
    case 'xlsx':
    case 'ods':
      return 'sheet';
    default:
      return null;
  }
}

export interface TabRegistration {
  kind: 'query' | 'param';
  draft: () => EditorDraft['queries'] | EditorDraft['params'];
  apply: (card: ApplyCard) => void;
  /** Есть несохранённые правки: тогда мост не переключает вкладку (переключение их потеряет). */
  dirty: () => boolean;
}

/** applied — сразу в черновик; opened — в очередь, вкладка открыта; queued — в очередь без переключения. */
export type ApplyResult = 'applied' | 'opened' | 'queued';

export interface AssistantBridge {
  editor: EditorRegistration | null;
  /** Зарегистрированный документ; null — вкладка «Документ» не смонтирована или connector недоступен. */
  document: DocumentRegistration | null;
  /** Шаблон, для которого в этой сессии редактора connector уже создавался (формирование доступно),
   *  даже если вкладка «Документ» сейчас размонтирована; сбрасывается clearPending (уход из
   *  редактора) и регистрацией редактора другого шаблона. */
  documentAutomation: string | null;
  /** Зарегистрированный лист; null — вкладка «Документ» не смонтирована, шаблон не xlsx/ods
   *  или connector недоступен. */
  sheet: SheetRegistration | null;
  registerEditor(r: EditorRegistration): () => void;
  registerTab(r: TabRegistration): () => void;
  /** Прочие вкладки с черновиком (диаграммы, PDF, настройки): только признак несохранённых правок. */
  registerDirty(probe: () => boolean): () => void;
  /** Черновики смонтированных вкладок, иначе сохранённое; null — редактор не открыт. */
  draft(): EditorDraft | null;
  /** Вкладка смонтирована — сразу в её черновик; иначе в очередь и открыть вкладку,
   *  если другая открытая вкладка не держит несохранённых правок. */
  apply(card: ApplyCard): ApplyResult | null;
  takePending(kind: 'query' | 'param'): ApplyCard[];
  /** Редактор закрыт: очередь сбрасывается, чтобы карточка не применилась при следующем заходе. */
  clearPending(): void;
  registerDocument(r: DocumentRegistration): () => void;
  /** Документ этого шаблона зарегистрирован — сразу run; иначе run откладывается до регистрации
   *  документа и открывается вкладка «Документ» ('opened'), если другая вкладка не держит
   *  несохранённых правок ('queued'). null — открыт не тот шаблон или редактор закрыт.
   *  editable — признак этой регистрации: отложенный run проверяет блокировку в момент запуска.
   *  dropped — отложенный run снят без запуска (clearPending, revokeDocument, другой шаблон). */
  applyDocument<T>(
    templateId: string,
    run: DocumentRun<T>,
    dropped?: () => void,
  ): Promise<T | 'opened' | 'queued' | null>;
  /** Возможности формирования у шаблона больше нет (конфиг редактора без documentAutomation,
   *  createConnector нет или бросил): признак снимается, отложенные run шаблона сбрасываются. */
  revokeDocument(templateId: string): void;
  /** Как registerDocument: выставляет documentAutomation и запускает отложенные run листа шаблона
   *  (отложенные run документа не трогает). */
  registerSheet(r: SheetRegistration): () => void;
  /** Как applyDocument, но run ждёт регистрации листа (registerSheet), а не документа. */
  applySheet<T>(
    templateId: string,
    run: SheetRun<T>,
    dropped?: () => void,
  ): Promise<T | 'opened' | 'queued' | null>;
  /** Снимок зарегистрированного листа; нет листа, ошибка или нет ответа за 3 с — undefined. */
  sheetSnapshot(): Promise<SheetSnapshot | undefined>;
  /** Снимок зарегистрированного документа; нет документа, ошибка или нет ответа за 3 с — undefined. */
  snapshot(): Promise<DocSnapshot | undefined>;
}

export type DocumentRun<T> = (a: DocumentAdapter, editable: () => boolean) => Promise<T>;
export type SheetRun<T> = (a: SheetAdapter, editable: () => boolean) => Promise<T>;

/** Отложенный run формирования: запускается регистрацией своего вида (документ или лист). */
type PendingDocument =
  | { kind: 'document'; templateId: string; run: DocumentRun<unknown>; dropped?: () => void }
  | { kind: 'sheet'; templateId: string; run: SheetRun<unknown>; dropped?: () => void };

/** Снимок с пределом ожидания: ошибка или нет ответа за SNAPSHOT_TIMEOUT_MS — undefined. */
async function snapshotWithin<T>(take: () => Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), SNAPSHOT_TIMEOUT_MS);
  });
  try {
    return await Promise.race([take(), late]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Снимок для запроса чата: дольше не ждём, реплика уходит без документа. */
const SNAPSHOT_TIMEOUT_MS = 3_000;

// Пределы EditorDraft на сервере: лишнее не отправляем, иначе сервер отклонит весь запрос чата.
const MAX_QUERIES = 30;
const MAX_PARAMS = 50;
const MAX_SQL = 20_000;
const MAX_KEY = 100;

/** Черновик в пределах схемы EditorDraft: длинные и невалидные элементы отбрасываются, списки обрезаются. */
export function limitDraft(d: EditorDraft): EditorDraft {
  return {
    queries: d.queries
      .filter((q) => q.sql.length <= MAX_SQL && q.key.length <= MAX_KEY)
      .slice(0, MAX_QUERIES),
    params: d.params.filter((p) => TemplateParam.safeParse(p).success).slice(0, MAX_PARAMS),
  };
}

const Ctx = createContext<AssistantBridge | null>(null);

export function AssistantBridgeProvider({ children }: { children: ReactNode }) {
  // editor и документ — в состоянии: панель включает кнопки «Применить», только пока редактор открыт.
  // Вкладки, очередь и текущий редактор для методов — в ref: методы стабильны, и их регистрация
  // в эффектах редактора и вкладок не зацикливается на перерисовке моста.
  const [editor, setEditor] = useState<EditorRegistration | null>(null);
  const editorRef = useRef<EditorRegistration | null>(null);
  const tabs = useRef(new Map<'query' | 'param', TabRegistration>());
  const pending = useRef<ApplyCard[]>([]);
  const probes = useRef(new Set<() => boolean>());
  const [openDocument, setDocument] = useState<DocumentRegistration | null>(null);
  const documentRef = useRef<DocumentRegistration | null>(null);
  const [documentAutomation, setDocumentAutomation] = useState<string | null>(null);
  const pendingDocument = useRef<PendingDocument[]>([]);
  const [openSheet, setSheet] = useState<SheetRegistration | null>(null);
  const sheetRef = useRef<SheetRegistration | null>(null);
  const methods = useMemo<
    Omit<AssistantBridge, 'editor' | 'document' | 'documentAutomation' | 'sheet'>
  >(() => {
    /** Снять отложенные run документа, подходящие под условие, и сообщить о снятии. */
    const dropDocuments = (match: (p: PendingDocument) => boolean) => {
      const gone = pendingDocument.current.filter(match);
      pendingDocument.current = pendingDocument.current.filter((p) => !match(p));
      for (const p of gone) p.dropped?.();
    };
    const othersDirty = () =>
      [...tabs.current.values()].some((t) => t.dirty()) || [...probes.current].some((p) => p());
    /** Забрать отложенные run этого вида и шаблона. */
    const takeDocuments = (kind: PendingDocument['kind'], templateId: string) => {
      const match = (p: PendingDocument) => p.kind === kind && p.templateId === templateId;
      const mine = pendingDocument.current.filter(match);
      pendingDocument.current = pendingDocument.current.filter((p) => !match(p));
      return mine;
    };
    /** Отложить run до регистрации и открыть вкладку «Документ», если это не потеряет правок. */
    const defer = (p: PendingDocument, ed: EditorRegistration): 'opened' | 'queued' => {
      pendingDocument.current.push(p);
      // Как apply(): переключение потеряло бы несохранённые правки открытой вкладки.
      if (othersDirty()) return 'queued';
      ed.openTab('document');
      return 'opened';
    };
    return {
      registerEditor: (r) => {
        // Очередь другого шаблона не должна достаться этому. Очередь того же шаблона сохраняется:
        // редактор перерегистрируется при каждом обновлении шаблона с сервера.
        pending.current = pending.current.filter((c) => c.templateId === r.templateId);
        dropDocuments((p) => p.templateId !== r.templateId);
        editorRef.current = r;
        setEditor(r);
        // Признак возможности другого шаблона не переносится. Тот же шаблон — сохраняется:
        // перерегистрация на каждом обновлении шаблона не должна убирать кнопки формирования.
        setDocumentAutomation((t) => (t === r.templateId ? t : null));
        return () => {
          if (editorRef.current !== r) return;
          editorRef.current = null;
          setEditor(null);
        };
      },
      registerTab: (r) => {
        tabs.current.set(r.kind, r);
        return () => {
          if (tabs.current.get(r.kind) === r) tabs.current.delete(r.kind);
        };
      },
      registerDirty: (probe) => {
        probes.current.add(probe);
        return () => {
          probes.current.delete(probe);
        };
      },
      draft: () => {
        const ed = editorRef.current;
        if (!ed) return null;
        const saved = ed.saved();
        return limitDraft({
          queries:
            (tabs.current.get('query')?.draft() as EditorDraft['queries'] | undefined) ??
            saved.queries,
          params:
            (tabs.current.get('param')?.draft() as EditorDraft['params'] | undefined) ??
            saved.params,
        });
      },
      apply: (card) => {
        const ed = editorRef.current;
        // Карточка другого шаблона (редактор закрыт или открыт другой) не применяется.
        if (!ed || ed.templateId !== card.templateId) return null;
        const tab = tabs.current.get(card.type);
        if (tab) {
          tab.apply(card);
          return 'applied';
        }
        pending.current.push(card);
        // Вкладки монтируются по одной: переключение потеряло бы несохранённые правки открытой.
        if (othersDirty()) return 'queued';
        ed.openTab(card.type === 'query' ? 'data' : 'params');
        return 'opened';
      },
      takePending: (kind) => {
        const mine = pending.current.filter((c) => c.type === kind);
        pending.current = pending.current.filter((c) => c.type !== kind);
        return mine;
      },
      clearPending: () => {
        pending.current = [];
        dropDocuments(() => true);
        // Вызывается при уходе из редактора: возможность подтверждается заново в следующей сессии.
        setDocumentAutomation(null);
      },
      registerDocument: (r) => {
        documentRef.current = r;
        setDocument(r);
        setDocumentAutomation(r.templateId);
        // Результат и ошибки отложенного run обрабатывает он сам: вызвавший уже получил 'opened'/'queued'.
        for (const p of takeDocuments('document', r.templateId)) {
          if (p.kind === 'document') void p.run(r.adapter, r.editable).catch(() => {});
        }
        return () => {
          if (documentRef.current !== r) return;
          documentRef.current = null;
          setDocument(null);
        };
      },
      applyDocument: async (templateId, run, dropped) => {
        const ed = editorRef.current;
        if (!ed || ed.templateId !== templateId) return null;
        const doc = documentRef.current;
        if (doc && doc.templateId === templateId) return run(doc.adapter, doc.editable);
        return defer({ kind: 'document', templateId, run, dropped }, ed);
      },
      revokeDocument: (templateId) => {
        setDocumentAutomation((t) => (t === templateId ? null : t));
        dropDocuments((p) => p.templateId === templateId);
      },
      snapshot: async () => {
        const doc = documentRef.current;
        if (!doc) return undefined;
        return snapshotWithin(() => doc.adapter.snapshot());
      },
      registerSheet: (r) => {
        sheetRef.current = r;
        setSheet(r);
        // Возможность формирования одна на шаблон (§52.2): лист выставляет тот же признак.
        setDocumentAutomation(r.templateId);
        for (const p of takeDocuments('sheet', r.templateId)) {
          if (p.kind === 'sheet') void p.run(r.adapter, r.editable).catch(() => {});
        }
        return () => {
          if (sheetRef.current !== r) return;
          sheetRef.current = null;
          setSheet(null);
        };
      },
      applySheet: async (templateId, run, dropped) => {
        const ed = editorRef.current;
        if (!ed || ed.templateId !== templateId) return null;
        const sheet = sheetRef.current;
        if (sheet && sheet.templateId === templateId) return run(sheet.adapter, sheet.editable);
        return defer({ kind: 'sheet', templateId, run, dropped }, ed);
      },
      sheetSnapshot: async () => {
        const sheet = sheetRef.current;
        if (!sheet) return undefined;
        return snapshotWithin(() => sheet.adapter.snapshot());
      },
    };
  }, []);
  const value = useMemo<AssistantBridge>(
    () => ({ ...methods, editor, document: openDocument, documentAutomation, sheet: openSheet }),
    [methods, editor, openDocument, documentAutomation, openSheet],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAssistantBridge(): AssistantBridge {
  const b = useContext(Ctx);
  if (!b) throw new Error('AssistantBridgeProvider missing');
  return b;
}

/** Мост, если он есть: редактор и вкладки рендерятся и вне Layout (в тестах). */
export function useOptionalAssistantBridge(): AssistantBridge | null {
  return useContext(Ctx);
}

/** Вкладка без карточек сообщает мосту о несохранённых правках: применение не переключит вкладку. */
export function useBridgeDirty(dirty: boolean): void {
  const registerDirty = useOptionalAssistantBridge()?.registerDirty;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => registerDirty?.(() => dirtyRef.current), [registerDirty]);
}

type QueryFields = { key: string; mode: QueryMode; sql: string };

/** Запрос из карточки: тот же ключ — замена SQL и режима на месте, иначе — в конец. */
export function applyQuery<T extends QueryFields>(
  drafts: T[],
  card: Extract<Card, { type: 'query' }>,
  make: (q: QueryFields) => T,
): T[] {
  const q = { key: card.key, mode: card.mode, sql: card.sql };
  const i = drafts.findIndex((d) => d.key === card.key);
  if (i < 0) return [...drafts, make(q)];
  return drafts.map((d, j) => (j === i ? { ...d, mode: q.mode, sql: q.sql } : d));
}

/** Параметр из карточки: то же имя — замена на месте (с прежним id), иначе — в конец. */
export function applyParam<T extends { name: string }>(
  drafts: T[],
  card: Extract<Card, { type: 'param' }>,
  make: (p: TemplateParam) => T,
): T[] {
  const i = drafts.findIndex((d) => d.name === card.param.name);
  if (i < 0) return [...drafts, make(card.param)];
  const made = make(card.param);
  // Поля параметра — из карточки, id черновика прежний: строка остаётся на месте и не пересоздаётся.
  return drafts.map((d, j) => (j !== i ? d : 'id' in d ? { ...made, id: d.id } : made));
}
