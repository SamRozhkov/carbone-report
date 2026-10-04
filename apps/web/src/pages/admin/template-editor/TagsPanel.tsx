import { ArrowsRotateRight, Copy } from '@gravity-ui/icons';
import { Button, Icon, Text, useToaster } from '@gravity-ui/uikit';
import type { TagNode } from '../../../lib/tagTree';
import { buildTagTree } from '../../../lib/tagTree';

let toastSeq = 0;

function TagRow({ tag, hint }: { tag: string; hint?: string }) {
  const { add } = useToaster();
  const copy = async () => {
    // Имя уникально для каждого события, иначе Toaster склеит повторные уведомления.
    const name = `tag-copy-${++toastSeq}`;
    try {
      await navigator.clipboard.writeText(tag);
      add({ name, title: `Скопировано: ${tag}`, theme: 'success', autoHiding: 2000 });
    } catch {
      add({ name, title: 'Не удалось скопировать — выделите тег вручную', theme: 'warning' });
    }
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <Text variant="code-1">{tag}</Text>
      {hint && (
        <Text variant="caption-2" color="secondary">
          {hint}
        </Text>
      )}
      <Button
        view="flat"
        size="xs"
        aria-label={`Скопировать ${tag}`}
        title="Скопировать"
        onClick={copy}
      >
        <Icon data={Copy} size={12} />
      </Button>
    </div>
  );
}

function NodeView({ node, depth }: { node: TagNode; depth: number }) {
  return (
    <div style={{ paddingLeft: depth * 12 }}>
      <Text variant="subheader-1" as="div">
        {node.label}
        {node.sample !== null && (
          <Text variant="caption-2" color="secondary">
            {' '}
            = {node.sample}
          </Text>
        )}
      </Text>
      {node.hint && (
        <Text variant="caption-2" color="danger" as="div">
          {node.hint}
        </Text>
      )}
      {node.tag && <TagRow tag={node.tag} hint={node.nextRowTag ? 'строка цикла' : undefined} />}
      {node.children.map((c) => (
        <NodeView key={c.id} node={c} depth={depth + 1} />
      ))}
      {node.nextRowTag && <TagRow tag={node.nextRowTag} hint="следующая строка — конец цикла" />}
    </div>
  );
}

export function TagsPanel({
  data,
  onRefresh,
  refreshing,
}: {
  data: Record<string, unknown> | null;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  return (
    <div
      className="cr-stack"
      style={{ width: 320, flexShrink: 0, overflow: 'auto', maxHeight: 'calc(100vh - 260px)' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text variant="subheader-2">Теги</Text>
        <Button size="s" onClick={onRefresh} loading={refreshing}>
          <Icon data={ArrowsRotateRight} />
          Обновить данные
        </Button>
      </div>
      {data ? (
        buildTagTree(data).map((n) => <NodeView key={n.id} node={n} depth={0} />)
      ) : (
        <Text color="secondary">
          Нет данных предпросмотра. Нажмите «Обновить данные» — запросы шаблона выполнятся с
          тестовыми параметрами.
        </Text>
      )}
    </div>
  );
}
