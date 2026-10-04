import type { ParamsInput, TemplateAdminDetails, TemplateParam } from '@carbone-reports/shared';
import type { QueryClient } from '@tanstack/react-query';
import { initialValues } from '../../../lib/params';
import { useStoredState } from '../../../lib/storage';

export const templateKey = (id: string) => ['template-admin', id] as const;

export function applyTemplate(queryClient: QueryClient, t: TemplateAdminDetails): void {
  queryClient.setQueryData(templateKey(t.id), t);
  void queryClient.invalidateQueries({ queryKey: ['templates'] });
  void queryClient.invalidateQueries({ queryKey: ['template', t.id] });
}

export function useTestParams(
  templateId: string,
  params: TemplateParam[],
): [ParamsInput, (v: ParamsInput) => void] {
  const [stored, setStored] = useStoredState<ParamsInput>(`cr-test-params-${templateId}`, {});
  const values: ParamsInput = { ...initialValues(params) };
  const safe: ParamsInput =
    stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  for (const p of params) if (Object.hasOwn(safe, p.name)) values[p.name] = safe[p.name] ?? null;
  return [values, setStored];
}

export function usePreviewData(templateId: string) {
  return useStoredState<Record<string, unknown> | null>(`cr-preview-${templateId}`, null);
}

export interface TabProps {
  template: TemplateAdminDetails;
  testParams: ParamsInput;
  onTestParams: (v: ParamsInput) => void;
  previewData: Record<string, unknown> | null;
  onPreviewData: (v: Record<string, unknown> | null) => void;
}
