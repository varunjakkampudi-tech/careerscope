import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Slider } from './ui';

describe('slider fill', () => {
  it('gives repeated controls distinct label associations', () => {
    render(
      <>
        <Slider label="Minimum match" value={0} onChange={vi.fn()} />
        <Slider label="Minimum match" value={0} onChange={vi.fn()} />
      </>,
    );
    const sliders = screen.getAllByRole('slider', { name: 'Minimum match' });
    expect(sliders).toHaveLength(2);
    expect(sliders[0]!.id).not.toBe(sliders[1]!.id);
  });

  it.each([
    [0, 0, 100, 0],
    [50, 0, 100, 50],
    [100, 0, 100, 100],
    [75, 50, 100, 50],
    [120, 0, 100, 100],
    [0, 0, 0, 0],
  ])('paints value %s within %s-%s at %s percent', (value, min, max, fill) => {
    render(<Slider label="Minimum match" value={value} min={min} max={max} onChange={vi.fn()} />);
    expect(screen.getByRole('slider').style.backgroundImage).toContain(
      `var(--color-accent) ${fill}%, var(--color-border) ${fill}%`,
    );
  });

  it('updates the fill when the controlled value changes', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Slider label="Minimum match" value={0} onChange={onChange} />);
    fireEvent.change(screen.getByRole('slider'), { target: { value: '65' } });
    expect(onChange).toHaveBeenCalledWith(65);
    rerender(<Slider label="Minimum match" value={65} onChange={onChange} />);
    expect(screen.getByRole('slider').style.backgroundImage).toContain(
      'var(--color-accent) 65%, var(--color-border) 65%',
    );
  });
});
