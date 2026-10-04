import './monaco-setup';
import { Loader } from '@gravity-ui/uikit';
import Editor from '@monaco-editor/react';
import { useContext } from 'react';
import { ThemeContext } from '../app/theme';

export interface CodeEditorProps {
  value: string;
  onChange?: (v: string) => void;
  language: 'sql' | 'json';
  readOnly?: boolean;
  height?: number | string;
  ariaLabel: string;
}

export function CodeEditor({
  value,
  onChange,
  language,
  readOnly,
  height = 320,
  ariaLabel,
}: CodeEditorProps) {
  const { theme } = useContext(ThemeContext);
  return (
    <div
      aria-label={ariaLabel}
      style={{
        border: '1px solid var(--g-color-line-generic)',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      <Editor
        height={height}
        language={language}
        value={value}
        onChange={(v) => onChange?.(v ?? '')}
        theme={theme === 'dark' ? 'vs-dark' : 'vs'}
        loading={<Loader />}
        options={{
          readOnly,
          minimap: { enabled: false },
          fontSize: 13,
          automaticLayout: true,
          scrollBeyondLastLine: false,
          wordWrap: 'on',
        }}
      />
    </div>
  );
}
