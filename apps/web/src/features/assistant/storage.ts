// Диалог ассистента живёт во вкладке (§50.1): sessionStorage, очищается при выходе.
import type { ChatTurn, RunCard } from '@carbone-reports/shared';

export const ASSISTANT_KEY = 'cr-assistant';
const MAX_TURNS = 20;
const MAX_LEN = 4000;

export interface PanelMessage {
  role: 'user' | 'assistant';
  content: string;
  card?: RunCard;
}
export interface AssistantState {
  open: boolean;
  messages: PanelMessage[];
}

const EMPTY: AssistantState = { open: false, messages: [] };

export function loadAssistant(): AssistantState {
  try {
    const raw = sessionStorage.getItem(ASSISTANT_KEY);
    const s = raw ? (JSON.parse(raw) as AssistantState) : null;
    return s && Array.isArray(s.messages) ? { open: !!s.open, messages: s.messages } : EMPTY;
  } catch {
    return EMPTY;
  }
}

export function saveAssistant(s: AssistantState): void {
  try {
    sessionStorage.setItem(ASSISTANT_KEY, JSON.stringify(s));
  } catch {
    // sessionStorage недоступен — диалог живёт до перезагрузки
  }
}

export function clearAssistant(): void {
  try {
    sessionStorage.removeItem(ASSISTANT_KEY);
  } catch {
    // sessionStorage недоступен
  }
}

/** История для API: карточка — текстом после реплики; пустые реплики пропускаются; последние 20. */
export function toHistory(messages: PanelMessage[], cardText: (c: RunCard) => string): ChatTurn[] {
  return messages
    .map((m) => ({
      role: m.role,
      content: [m.content, m.card ? cardText(m.card) : '']
        .filter(Boolean)
        .join('\n')
        .slice(0, MAX_LEN),
    }))
    .filter((m) => m.content.trim() !== '')
    .slice(-MAX_TURNS);
}
