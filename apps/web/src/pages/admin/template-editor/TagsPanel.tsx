import { ArrowsRotateRight, ChevronDown, ChevronRight, Copy } from '@gravity-ui/icons';
import { Button, Icon, Link, Text, TextInput } from '@gravity-ui/uikit';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCopy } from '../../../components/useCopy';
import type { TagNode } from '../../../lib/tagTree';
import { buildTagTree } from '../../../lib/tagTree';
import { chartTag } from './ChartsTab';
import { SNIPPETS, SNIPPET_GROUPS, snippetText } from './snippets';

export function filterTree(nodes: TagNode[], query: string): TagNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;
  const hit = (n: TagNode) =>
    n.label.toLowerCase().includes(q) ||
    (n.tag ?? '').toLowerCase().includes(q) ||
    (n.nextRowTag ?? '').toLowerCase().includes(q);
  return nodes.flatMap((n) => {
    if (hit(n)) return [n];
    const children = filterTree(n.children, q);
    return children.length > 0 ? [{ ...n, children }] : [];
  });
}

export function TagTile({
  text,
  hint,
  editing,
}: {
  text: string;
  hint?: string;
  editing: boolean;
}) {
  const { t } = useTranslation();
  const copy = useCopy();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span
        className="cr-tag-tile"
        draggable={editing}
        title={editing ? t('editor:tags.dragHint') : undefined}
        style={{ cursor: editing ? 'grab' : undefined }}
        onDragStart={(e) => {
          e.dataTransfer.setData('text/plain', text);
          e.dataTransfer.effectAllowed = 'copy';
        }}
      >
        <Text variant="code-1">{text}</Text>
      </span>
      {hint && (
        <Text variant="caption-2" color="secondary">
          {hint}
        </Text>
      )}
      <Button
        view="flat"
        size="xs"
        aria-label={t('editor:tags.copyAria', { text })}
        title={t('editor:tags.copy')}
        onClick={() => void copy(text)}
      >
        <Icon data={Copy} size={12} />
      </Button>
    </div>
  );
}

function NodeView({
  node,
  depth,
  expanded,
  toggle,
  forceOpen,
  editing,
}: {
  node: TagNode;
  depth: number;
  expanded: Set<string>;
  toggle: (id: string) => void;
  forceOpen: boolean;
  editing: boolean;
}) {
  const { t } = useTranslation();
  const hasChildren = node.children.length > 0;
  const open = forceOpen || expanded.has(node.id);
  return (
    <div style={{ paddingLeft: depth * 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        {/* Во время поиска всё раскрыто принудительно — кнопка ничего бы не делала. */}
        {hasChildren && !forceOpen && (
          <Button
            view="flat"
            size="xs"
            aria-label={t(open ? 'editor:tags.collapseAria' : 'editor:tags.expandAria', {
              label: node.label,
            })}
            onClick={() => toggle(node.id)}
          >
            <Icon data={open ? ChevronDown : ChevronRight} size={12} />
          </Button>
        )}
        <Text variant="subheader-1" as="div">
          {node.label}
          {node.sample !== null && (
            <Text variant="caption-2" color="secondary">
              {' '}
              = {node.sample}
            </Text>
          )}
        </Text>
      </div>
      {node.badKey && (
        <Text variant="caption-2" color="danger" as="div">
          {t('editor:tags.badKey')}
        </Text>
      )}
      {node.tag && (
        <TagTile
          text={node.tag}
          hint={node.nextRowTag ? t('editor:tags.loopRow') : undefined}
          editing={editing}
        />
      )}
      {open &&
        node.children.map((c) => (
          <NodeView
            key={c.id}
            node={c}
            depth={depth + 1}
            expanded={expanded}
            toggle={toggle}
            forceOpen={forceOpen}
            editing={editing}
          />
        ))}
      {(open || !hasChildren) && node.nextRowTag && (
        <TagTile text={node.nextRowTag} hint={t('editor:tags.loopEnd')} editing={editing} />
      )}
    </div>
  );
}

export function TagsPanel({
  data,
  charts = [],
  onRefresh,
  refreshing,
  editing,
}: {
  data: Record<string, unknown> | null;
  /** Ключи графиков шаблона (§35.5): `{d.charts.<key>:chart}`. */
  charts?: string[];
  onRefresh: () => void;
  refreshing: boolean;
  /** Документ редактируется здесь — плитки тегов можно перетаскивать в документ. */
  editing: boolean;
}) {
  const { t } = useTranslation();
  // При графиках d.charts — их описания ECharts: деревом не показываем, теги — отдельным блоком.
  const tree = useMemo(
    () =>
      data
        ? buildTagTree(
            charts.length > 0
              ? Object.fromEntries(Object.entries(data).filter(([k]) => k !== 'charts'))
              : data,
          )
        : null,
    [data, charts.length],
  );
  const rootKey = tree ? tree.map((n) => n.id).join('\n') : '';
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(tree?.map((n) => n.id)));
  // При смене набора корней (новые данные) снова раскрываем первый уровень.
  useEffect(() => {
    setExpanded(new Set(rootKey ? rootKey.split('\n') : []));
  }, [rootKey]);
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const [query, setQuery] = useState('');
  const searching = query.trim() !== '';
  const shown = tree ? filterTree(tree, query) : null;
  return (
    <div className="cr-stack cr-tags-panel">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text variant="subheader-2">{t('editor:tags.title')}</Text>
        <Button size="s" onClick={onRefresh} loading={refreshing}>
          <Icon data={ArrowsRotateRight} />
          {t('editor:tags.refresh')}
        </Button>
      </div>
      {charts.length > 0 && (
        <div className="cr-stack">
          <Text variant="subheader-1">{t('editor:tab.charts')}</Text>
          {charts.map((key) => (
            <TagTile
              key={key}
              text={chartTag(key)}
              hint={t('editor:tags.chartHint')}
              editing={editing}
            />
          ))}
        </div>
      )}
      <details className="cr-snippets">
        <summary>
          <Text variant="subheader-1">{t('editor:snippet.title')}</Text>
        </summary>
        {SNIPPET_GROUPS.map((g) => (
          <div key={g} className="cr-stack" style={{ gap: 4 }}>
            <Text variant="caption-2" color="secondary">
              {t(`editor:snippet.group_${g}`)}
            </Text>
            {SNIPPETS.filter((s) => s.group === g).map((s) => (
              <div key={s.id}>
                <Text variant="caption-2">{t(`editor:snippet.${s.id}`)} </Text>
                <Link href={`/admin/help#${s.helpId}`} target="_blank" rel="noopener">
                  {t('editor:snippet.more')}
                </Link>
                <TagTile text={snippetText(s)} editing={editing} />
              </div>
            ))}
          </div>
        ))}
      </details>
      {tree && (
        <TextInput
          type="search"
          placeholder={t('editor:tags.search')}
          value={query}
          onUpdate={setQuery}
          controlProps={{ 'aria-label': t('editor:tags.searchAria') }}
        />
      )}
      {shown ? (
        shown.length === 0 && searching ? (
          <Text color="secondary">{t('editor:tags.nothingFound')}</Text>
        ) : (
          shown.map((n) => (
            <NodeView
              key={n.id}
              node={n}
              depth={0}
              expanded={expanded}
              toggle={toggle}
              forceOpen={searching}
              editing={editing}
            />
          ))
        )
      ) : (
        <Text color="secondary">{t('editor:tags.noData')}</Text>
      )}
    </div>
  );
}
