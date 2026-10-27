import type { Card, EditorDraft, QueryMode } from '@carbone-reports/shared';
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

/** Мост панели ассистента и редактора шаблона (§51.5). */

export type ApplyCard = Extract<Card, { type: 'query' } | { type: 'param' }>;

export interface EditorRegistration {
  templateId: string;
  templateName: string;
  /** Сохранённые запросы и параметры — для вкладок, которые сейчас не открыты. */
  saved: () => EditorDraft;
  openTab: (tab: 'data' | 'params') => void;
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
}

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
  // editor — в состоянии: панель включает кнопки «Применить», только пока редактор открыт.
  // Вкладки, очередь и текущий редактор для методов — в ref: методы стабильны, и их регистрация
  // в эффектах редактора и вкладок не зацикливается на перерисовке моста.
  const [editor, setEditor] = useState<EditorRegistration | null>(null);
  const editorRef = useRef<EditorRegistration | null>(null);
  const tabs = useRef(new Map<'query' | 'param', TabRegistration>());
  const pending = useRef<ApplyCard[]>([]);
  const probes = useRef(new Set<() => boolean>());
  const methods = useMemo<Omit<AssistantBridge, 'editor'>>(
    () => ({
      registerEditor: (r) => {
        // Очередь другого шаблона не должна достаться этому. Очередь того же шаблона сохраняется:
        // редактор перерегистрируется при каждом обновлении шаблона с сервера.
        pending.current = pending.current.filter((c) => c.templateId === r.templateId);
        editorRef.current = r;
        setEditor(r);
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
        if (
          [...tabs.current.values()].some((t) => t.dirty()) ||
          [...probes.current].some((p) => p())
        )
          return 'queued';
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
      },
    }),
    [],
  );
  const value = useMemo<AssistantBridge>(() => ({ ...methods, editor }), [methods, editor]);
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
