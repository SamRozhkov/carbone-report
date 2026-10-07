import { Copy } from '@gravity-ui/icons';
import { Alert, Button, Icon, Link, Text } from '@gravity-ui/uikit';
import { Fragment, type ReactNode } from 'react';
import { PageHeader } from '../../../components/PageHeader';
import { useCopy } from '../../../components/useCopy';
import { HELP_INTRO, HELP_SECTIONS, type HelpExample, type HelpSection } from './content';

const MODE_LABEL = { list: 'Список строк', single: 'Одна строка' } as const;

/** Текст, где `код` в обратных кавычках показывается моноширинным. */
function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split('`').map((part, i) =>
        i % 2 === 1 ? (
          <code key={i} className="cr-help-inline">
            {part}
          </code>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

function Block({ label, action, text }: { label: string; action?: ReactNode; text: string }) {
  return (
    <div>
      <div className="cr-help-label">
        <Text variant="caption-2" color="secondary">
          {label}
        </Text>
        {action}
      </div>
      <pre className="cr-help-code">{text}</pre>
    </div>
  );
}

function ExampleCard({ example }: { example: HelpExample }) {
  const copy = useCopy();
  return (
    <article id={example.id} className="cr-help-card" aria-label={example.title}>
      <Text variant="subheader-2" as="h3">
        {example.title}
      </Text>
      {example.sql && (
        <Block
          label={`SQL-запрос «${example.sql.key}» (${MODE_LABEL[example.sql.mode]})`}
          text={example.sql.text}
        />
      )}
      <Block
        label="Тег в шаблоне"
        text={example.template}
        action={
          <Button
            view="flat"
            size="xs"
            aria-label={`Копировать тег: ${example.title}`}
            onClick={() => void copy(example.template, example.title)}
          >
            <Icon data={Copy} size={12} />
            Копировать
          </Button>
        }
      />
      <Block label="Данные" text={example.data} />
      <Block label="Результат" text={example.result} />
      {example.note && (
        <Alert
          theme={example.unavailable ? 'info' : 'warning'}
          title="Внимание"
          message={<Rich text={example.note} />}
        />
      )}
    </article>
  );
}

function Section({ section }: { section: HelpSection }) {
  return (
    <section id={section.id} className="cr-help-section" aria-label={section.title}>
      <Text variant="header-2" as="h2">
        {section.title}
      </Text>
      {section.intro.map((p, i) => (
        <Text key={i} as="p">
          <Rich text={p} />
        </Text>
      ))}
      {section.examples.map((e) => (
        <ExampleCard key={e.id} example={e} />
      ))}
      {section.limits && (
        <ul className="cr-help-limits">
          {section.limits.map((l) => (
            <li key={l.id} id={l.id}>
              <Text variant="subheader-1">{l.title}</Text> — <Rich text={l.instead} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function HelpPage() {
  return (
    <>
      <PageHeader title="Справка по шаблонам" />
      <div className="cr-help">
        <nav className="cr-help-toc" aria-label="Оглавление">
          {HELP_SECTIONS.map((s) => (
            <Link key={s.id} href={`#${s.id}`}>
              {s.title}
            </Link>
          ))}
        </nav>
        <div className="cr-help-content">
          {HELP_INTRO.map((p, i) => (
            <Text key={i} as="p">
              <Rich text={p} />
            </Text>
          ))}
          {HELP_SECTIONS.map((s) => (
            <Section key={s.id} section={s} />
          ))}
        </div>
      </div>
    </>
  );
}
