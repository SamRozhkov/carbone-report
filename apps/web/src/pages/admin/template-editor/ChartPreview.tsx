import { type ChartValue, reviveChartFormatters } from '@carbone-reports/shared';
import { Text } from '@gravity-ui/uikit';
import * as echarts from 'echarts';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

const WIDTH = 600;
const HEIGHT = 360;

/**
 * Предпросмотр графика конструктора (§35.5): ECharts в браузере (SVG), те же значения по умолчанию, что у сервера
 * (белый фон, без анимации, маркеры формата чисел — функции). Модуль грузится отдельным чанком (lazy в ChartsTab).
 */
export function ChartPreview({ value }: { value: ChartValue }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    let chart: echarts.ECharts | null = null;
    try {
      chart = echarts.init(ref.current, null, {
        renderer: 'svg',
        width: WIDTH,
        height: HEIGHT,
      });
      chart.setOption({
        backgroundColor: '#ffffff',
        textStyle: { fontFamily: '"Noto Sans", sans-serif' },
        ...reviveChartFormatters(value.option),
        animation: false,
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    return () => chart?.dispose();
  }, [value]);
  return (
    <div className="cr-stack">
      <div
        ref={ref}
        data-testid="chart-preview"
        style={{ width: WIDTH, height: HEIGHT, border: '1px solid var(--g-color-line-generic)' }}
      />
      {error && <Text color="danger">{t('editor:charts.echartsError', { error })}</Text>}
    </div>
  );
}
