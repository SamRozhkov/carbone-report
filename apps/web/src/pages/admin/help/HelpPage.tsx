import { Copy } from '@gravity-ui/icons';
import { Alert, Button, Icon, Link, Text } from '@gravity-ui/uikit';
import { LOCALE_NAMES, type Locale } from '@carbone-reports/shared/i18n';
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../../components/PageHeader';
import { useCopy } from '../../../components/useCopy';
import { useLocale } from '../../../i18n';
import {
  HELP_RU,
  loadHelpContent,
  type HelpContent,
  type HelpExample,
  type HelpSection,
} from './content';

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
  const { t } = useTranslation('help');
  const copy = useCopy();
  const hasTableRows = example.template.split('\n').some((l) => l.startsWith('|'));
  return (
    <article id={example.id} className="cr-help-card" aria-label={example.title}>
      <Text variant="subheader-2" as="h3">
        {example.title}
      </Text>
      {example.sql && (
        <Block
          label={t('label.sql', { key: example.sql.key, mode: t(`mode.${example.sql.mode}`) })}
          text={example.sql.text}
        />
      )}
      <Block
        label={example.picture ? t('label.picture') : t('label.template')}
        text={example.template}
        action={
          example.antiPattern ? undefined : (
            <span className="cr-help-actions">
              {hasTableRows && (
                <Text variant="caption-2" color="secondary">
                  {t('tableHint')}
                </Text>
              )}
              <Button
                view="flat"
                size="xs"
                aria-label={t('copyAria', { title: example.title })}
                onClick={() => void copy(example.template, example.title)}
              >
                <Icon data={Copy} size={12} />
                {t('copy')}
              </Button>
            </span>
          )
        }
      />
      <Block label={t('label.data')} text={example.data} />
      <Block label={t('label.result')} text={example.result} />
      {example.note && (
        <Alert
          theme={example.unavailable ? 'info' : 'warning'}
          title={t('note')}
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

/** Загруженная справка и язык её примеров. */
interface HelpState {
  content: HelpContent;
  failed: boolean;
  /** Для какого языка отчёта посчитаны результаты примеров: ru при запасной справке (§46.1). */
  resultsLocale: Locale;
}

/** Справка на языке интерфейса; пока модуль грузится, видна прежняя (сначала — ru, §46.2). */
function useHelpContent(locale: Locale): HelpState {
  const [state, setState] = useState<HelpState>({
    content: HELP_RU,
    failed: false,
    resultsLocale: 'ru',
  });
  useEffect(() => {
    let alive = true;
    void loadHelpContent(locale).then(({ content, failed }) => {
      if (!alive) return;
      const resultsLocale: Locale = content === HELP_RU ? 'ru' : locale;
      // То же содержимое (ru при открытии) — без лишней перерисовки всей справки.
      setState((prev) =>
        prev.content === content && prev.failed === failed && prev.resultsLocale === resultsLocale
          ? prev
          : { content, failed, resultsLocale },
      );
    });
    return () => {
      alive = false;
    };
  }, [locale]);
  return state;
}

export function HelpPage() {
  const { t } = useTranslation('help');
  const { content, failed, resultsLocale } = useHelpContent(useLocale());
  return (
    <>
      <PageHeader title={t('title')} />
      <div className="cr-help">
        <nav className="cr-help-toc" aria-label={t('toc')}>
          {content.HELP_SECTIONS.map((s) => (
            <Link key={s.id} href={`#${s.id}`}>
              {s.title}
            </Link>
          ))}
        </nav>
        <div className="cr-help-content">
          {failed && <Alert theme="warning" message={t('loadFailed')} />}
          <Text as="p" color="secondary">
            {t('resultsFor', { language: LOCALE_NAMES[resultsLocale] })}
          </Text>
          {content.HELP_INTRO.map((p, i) => (
            <Text key={i} as="p">
              <Rich text={p} />
            </Text>
          ))}
          {content.HELP_SECTIONS.map((s) => (
            <Section key={s.id} section={s} />
          ))}
        </div>
      </div>
    </>
  );
}
