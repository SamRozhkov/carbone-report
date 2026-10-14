import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChartPreview } from './ChartPreview';

// vi.mock поднимается выше импортов — заглушки создаются в vi.hoisted
const { init, setOption, dispose } = vi.hoisted(() => {
  const setOption = vi.fn();
  const dispose = vi.fn();
  return { setOption, dispose, init: vi.fn(() => ({ setOption, dispose })) };
});
vi.mock('echarts', () => ({ init }));

describe('ChartPreview', () => {
  it('ECharts SVG 600×360, белый фон, маркеры формата — функции; dispose при размонтировании', async () => {
    const { unmount } = render(
      <ChartPreview
        value={{
          type: 'echarts@v5',
          option: {
            yAxis: {
              axisLabel: { formatter: 'cr:number:{"decimals":0,"thousands":true,"suffix":""}' },
            },
          },
        }}
      />,
    );
    await waitFor(() => expect(setOption).toHaveBeenCalled());
    expect(init).toHaveBeenCalledWith(screen.getByTestId('chart-preview'), null, {
      renderer: 'svg',
      width: 600,
      height: 360,
    });
    const option = setOption.mock.calls[0]![0] as {
      backgroundColor: string;
      animation: boolean;
      yAxis: { axisLabel: { formatter: (v: number) => string } };
    };
    expect(option.backgroundColor).toBe('#ffffff');
    expect(option.animation).toBe(false);
    expect(option.yAxis.axisLabel.formatter(12345)).toBe('12 345');
    unmount();
    expect(dispose).toHaveBeenCalled();
  });
  it('ошибка ECharts — текст под графиком', async () => {
    setOption.mockImplementationOnce(() => {
      throw new Error('xAxis "0" not found');
    });
    render(<ChartPreview value={{ type: 'echarts@v5', option: {} }} />);
    expect(await screen.findByText('Ошибка ECharts: xAxis "0" not found')).toBeInTheDocument();
  });
  it('ошибка echarts.init — тот же текст под графиком', async () => {
    init.mockImplementationOnce(() => {
      throw new Error('Renderer svg not exists');
    });
    render(<ChartPreview value={{ type: 'echarts@v5', option: {} }} />);
    expect(await screen.findByText('Ошибка ECharts: Renderer svg not exists')).toBeInTheDocument();
  });
});
