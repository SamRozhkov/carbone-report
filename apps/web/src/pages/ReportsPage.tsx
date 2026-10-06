import type { TemplateSummary } from '@carbone-reports/shared';
import { Card, Label, Loader, Text, TextInput } from '@gravity-ui/uikit';
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api/endpoints';
import { useMe } from '../api/session';
import { ErrorAlert } from '../components/ErrorAlert';
import { PageHeader } from '../components/PageHeader';
import { formatDate } from '../lib/format';

const NO_CATEGORY = 'Без категории';

interface Section {
  key: string;
  title: string;
  items: TemplateSummary[];
}

/** Разделы каталога: категории по sortOrder и имени, шаблоны без категории — последним разделом «Без категории»; категория «Прочие» — обычная. */
function sectionsOf(list: TemplateSummary[]): Section[] {
  const byKey = new Map<string, Section & { sortOrder: number }>();
  for (const t of list) {
    const key = t.category?.id ?? '';
    let s = byKey.get(key);
    if (!s) {
      s = t.category
        ? { key, title: t.category.name, sortOrder: t.category.sortOrder, items: [] }
        : { key, title: NO_CATEGORY, sortOrder: 0, items: [] };
      byKey.set(key, s);
    }
    s.items.push(t);
  }
  return [...byKey.values()].sort((a, b) => {
    if (!a.key !== !b.key) return a.key ? -1 : 1;
    return a.sortOrder - b.sortOrder || a.title.localeCompare(b.title, 'ru');
  });
}

export function ReportsPage() {
  const me = useMe().data;
  const [query, setQuery] = useState('');
  const templates = useQuery({ queryKey: ['templates'], queryFn: api.templates.list });

  const q = query.trim().toLowerCase();
  const all = templates.data ?? [];
  const items = all.filter(
    (t) => !q || t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q),
  );
  // Заголовки нужны, только если в каталоге больше одного раздела; пустые после поиска скрываем.
  const showTitles = sectionsOf(all).length > 1;
  const sections = sectionsOf(items);

  let empty: string | null = null;
  if (templates.data && items.length === 0) {
    if (all.length > 0) empty = 'Ничего не найдено.';
    else if (me?.role === 'admin')
      empty = 'Шаблонов пока нет — создайте первый в разделе «Шаблоны».';
    else empty = 'Отчётов пока нет.';
  }

  return (
    <>
      <PageHeader
        title="Отчёты"
        actions={
          <TextInput
            placeholder="Поиск"
            value={query}
            onUpdate={setQuery}
            hasClear
            controlProps={{ 'aria-label': 'Поиск отчётов' }}
          />
        }
      />
      <ErrorAlert error={templates.error} />
      {templates.isPending && <Loader />}
      {empty && <Text color="secondary">{empty}</Text>}
      {showTitles ? (
        sections.map((s) => <CatalogSection key={s.key} section={s} />)
      ) : (
        <Cards items={items} />
      )}
    </>
  );
}

function CatalogSection({ section }: { section: Section }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="cr-catalog-section">
      <Text variant="subheader-3" as="h2" id={headingId}>
        {section.title}
      </Text>
      <Cards items={section.items} />
    </section>
  );
}

function Cards({ items }: { items: TemplateSummary[] }) {
  const navigate = useNavigate();
  return (
    <div className="cr-cards">
      {items.map((t) => (
        <Card
          key={t.id}
          type="action"
          view="outlined"
          className="cr-card"
          onClick={() => navigate(`/reports/${t.id}`)}
        >
          <Text variant="subheader-2" as="div">
            {t.name}
          </Text>
          {t.description && (
            <Text color="secondary" as="div">
              {t.description}
            </Text>
          )}
          <div className="cr-card-meta">
            <Label size="xs">{t.fileExt.toUpperCase()}</Label>
            <Text variant="caption-2" color="secondary">
              обновлён {formatDate(t.updatedAt)}
            </Text>
          </div>
        </Card>
      ))}
    </div>
  );
}
