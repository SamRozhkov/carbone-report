import type { TemplateSummary } from '@carbone-reports/shared';
import { Card, Label, Loader, Text, TextInput } from '@gravity-ui/uikit';
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { api } from '../api/endpoints';
import { usePermissions } from '../app/permissions';
import { ErrorAlert } from '../components/ErrorAlert';
import { PageHeader } from '../components/PageHeader';
import { currentLocale, i18n } from '../i18n';
import { formatDate } from '../lib/format';

interface Section {
  key: string;
  title: string;
  items: TemplateSummary[];
}

/** Разделы каталога: категории по sortOrder и имени, шаблоны без категории — последним разделом «Без категории»; категория «Прочие» — обычная. */
function sectionsOf(list: TemplateSummary[]): Section[] {
  const byKey = new Map<string, Section & { sortOrder: number }>();
  for (const tpl of list) {
    const key = tpl.category?.id ?? '';
    let s = byKey.get(key);
    if (!s) {
      s = tpl.category
        ? { key, title: tpl.category.name, sortOrder: tpl.category.sortOrder, items: [] }
        : { key, title: i18n.t('reports:list.noCategory'), sortOrder: 0, items: [] };
      byKey.set(key, s);
    }
    s.items.push(tpl);
  }
  return [...byKey.values()].sort((a, b) => {
    if (!a.key !== !b.key) return a.key ? -1 : 1;
    return a.sortOrder - b.sortOrder || a.title.localeCompare(b.title, currentLocale());
  });
}

export function ReportsPage() {
  const { canAuthor } = usePermissions();
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const templates = useQuery({ queryKey: ['templates'], queryFn: api.templates.list });

  const q = query.trim().toLowerCase();
  const all = templates.data ?? [];
  const items = all.filter(
    (tpl) => !q || tpl.name.toLowerCase().includes(q) || tpl.description.toLowerCase().includes(q),
  );
  // Заголовки нужны, только если в каталоге больше одного раздела; пустые после поиска скрываем.
  const showTitles = sectionsOf(all).length > 1;
  const sections = sectionsOf(items);

  let empty: string | null = null;
  if (templates.data && items.length === 0) {
    if (all.length > 0) empty = t('reports:list.notFound');
    else if (canAuthor) empty = t('reports:list.emptyAuthor');
    else empty = t('reports:list.empty');
  }

  return (
    <>
      <PageHeader
        title={t('reports:list.title')}
        actions={
          <TextInput
            placeholder={t('reports:list.search')}
            value={query}
            onUpdate={setQuery}
            hasClear
            controlProps={{ 'aria-label': t('reports:list.searchLabel') }}
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
  const { t } = useTranslation();
  return (
    <div className="cr-cards">
      {items.map((tpl) => (
        <Card
          key={tpl.id}
          type="action"
          view="outlined"
          className="cr-card"
          onClick={() => navigate(`/reports/${tpl.id}`)}
        >
          <Text variant="subheader-2" as="div">
            {tpl.name}
          </Text>
          {tpl.description && (
            <Text color="secondary" as="div">
              {tpl.description}
            </Text>
          )}
          <div className="cr-card-meta">
            <Label size="xs">{tpl.fileExt.toUpperCase()}</Label>
            <Text variant="caption-2" color="secondary">
              {t('reports:list.updated', { date: formatDate(tpl.updatedAt) })}
            </Text>
          </div>
        </Card>
      ))}
    </div>
  );
}
