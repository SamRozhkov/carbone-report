import { Card, Label, Loader, Text, TextInput } from '@gravity-ui/uikit';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api/endpoints';
import { useMe } from '../api/session';
import { ErrorAlert } from '../components/ErrorAlert';
import { PageHeader } from '../components/PageHeader';
import { formatDate } from '../lib/format';

export function ReportsPage() {
  const me = useMe().data;
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const templates = useQuery({ queryKey: ['templates'], queryFn: api.templates.list });

  const q = query.trim().toLowerCase();
  const all = templates.data ?? [];
  const items = all.filter(
    (t) => !q || t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q),
  );

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
    </>
  );
}
