/**
 * Regression tests for the skill-gap panel.
 *
 * These cover the three things that were actually wrong at some point, rather
 * than the whole surface: the panel rendering furniture when it had nothing to
 * say, the skeleton announcing itself to a screen reader, and the nested bar
 * geometry — which is the one piece of this component where a plausible-looking
 * change silently produces a chart that lies.
 */

import type { SkillGap } from '@job-radar/shared';
import { describe, expect, it, vi } from 'vitest';
import { SkillGapPanel, SkillGapPanelSkeleton } from './SkillGapPanel';
import { renderApp, screen, userEvent, within } from '../test/utils';

function gap(skill: string, nearMissCount: number, totalCount: number) {
  return { skill, nearMissCount, totalCount, averageScore: 0.78 };
}

function fixture(overrides: Partial<SkillGap> = {}): SkillGap {
  return {
    threshold: 0.85,
    nearMissFloor: 0.7,
    totalLeads: 162,
    nearMissLeads: 14,
    gaps: [gap('Kafka', 9, 22), gap('Java', 4, 31), gap('Kubernetes', 4, 12)],
    strengths: [gap('React', 0, 88)],
    ...overrides,
  };
}

describe('SkillGapPanel', () => {
  it('renders nothing when there are no gaps', () => {
    const { container } = renderApp(
      <SkillGapPanel data={fixture({ gaps: [] })} onPickSkill={vi.fn()} />,
    );

    // A fresh install has no leads. An empty panel here would be a box above an
    // empty table saying that it has nothing to say.
    expect(container).toBeEmptyDOMElement();
  });

  it('names the top three gaps in the collapsed summary', () => {
    renderApp(<SkillGapPanel data={fixture()} onPickSkill={vi.fn()} />);

    expect(
      screen.getByText('Kafka, Java and Kubernetes are what you are missing most'),
    ).toBeInTheDocument();
    expect(screen.getByText(/across 14 leads scoring 70%–85%\./)).toBeInTheDocument();
  });

  it('says so when nothing landed in the near-miss band', () => {
    renderApp(<SkillGapPanel data={fixture({ nearMissLeads: 0 })} onPickSkill={vi.fn()} />);

    // The panel falls back to ranking every lead, and has to admit that rather
    // than present a total as if it were a near-miss count.
    expect(
      screen.getByText(/nothing scored 70%–85%, so this ranks every lead instead\./),
    ).toBeInTheDocument();
  });

  it('passes the clicked skill up so the table can filter to it', async () => {
    const onPickSkill = vi.fn();
    renderApp(<SkillGapPanel data={fixture()} onPickSkill={onPickSkill} />);

    await userEvent.click(screen.getByRole('button', { name: /Kafka/ }));

    expect(onPickSkill).toHaveBeenCalledExactlyOnceWith('Kafka');
  });

  it('states both counts as text, so the bar is never the only way to read a row', () => {
    renderApp(<SkillGapPanel data={fixture()} onPickSkill={vi.fn()} />);

    const kafka = screen.getByRole('button', { name: /Kafka/ });
    expect(within(kafka).getByText(/9 near misses/)).toBeInTheDocument();
    expect(within(kafka).getByText(/22 overall/)).toBeInTheDocument();
  });

  it('singularises a lone near miss', () => {
    renderApp(
      <SkillGapPanel data={fixture({ gaps: [gap('Rust', 1, 3)] })} onPickSkill={vi.fn()} />,
    );

    expect(screen.getByText(/1 near miss(?!es)/)).toBeInTheDocument();
  });

  it('falls back to the overall count when a skill blocked no near miss', () => {
    renderApp(<SkillGapPanel data={fixture({ gaps: [gap('Go', 0, 5)] })} onPickSkill={vi.fn()} />);

    // Zero near misses must not print "0 near misses" — the honest statement is
    // the number of leads that asked for it at all.
    expect(screen.getByText('5 leads')).toBeInTheDocument();
    expect(screen.queryByText(/near miss/)).not.toBeInTheDocument();
  });

  /**
   * The geometry. `nearMissCount <= totalCount` holds by construction in the
   * API, and the render leans on it: both marks are absolutely positioned from
   * the same left edge on one scale, so the fill staying inside its track is a
   * consequence of that invariant rather than of any clamping here.
   *
   * If someone later scales the fill against `totalCount` instead of the shared
   * maximum — which is the natural-looking mistake, and makes each row's fill a
   * percentage of its own track — every bar becomes a proportion and the ranking
   * the panel exists to show disappears. These assertions fail loudly if that
   * happens.
   */
  describe('bar geometry', () => {
    function widths(button: HTMLElement) {
      const [track, fill] = Array.from(
        button.querySelectorAll<HTMLElement>('[aria-hidden="true"] > div'),
      );
      return {
        track: Number.parseFloat(track?.style.width ?? ''),
        fill: Number.parseFloat(fill?.style.width ?? ''),
      };
    }

    it('scales every row against the largest total, not against its own', () => {
      renderApp(<SkillGapPanel data={fixture()} onPickSkill={vi.fn()} />);

      // Java is the largest total (31), so it sets the scale and fills the row.
      const java = widths(screen.getByRole('button', { name: /Java/ }));
      expect(java.track).toBe(100);

      // Kafka's track is 22/31, and crucially NOT 100 — which is what it would
      // be if each row were scaled to itself.
      const kafka = widths(screen.getByRole('button', { name: /Kafka/ }));
      expect(kafka.track).toBeCloseTo((22 / 31) * 100, 5);
      expect(kafka.fill).toBeCloseTo((9 / 31) * 100, 5);
    });

    it('keeps the fill inside the track on every row', () => {
      renderApp(<SkillGapPanel data={fixture()} onPickSkill={vi.fn()} />);

      for (const skill of ['Kafka', 'Java', 'Kubernetes']) {
        const { track, fill } = widths(screen.getByRole('button', { name: new RegExp(skill) }));
        expect(fill).toBeLessThanOrEqual(track);
      }
    });

    it('gives a count of one a visible floor but leaves zero at zero width', () => {
      renderApp(
        <SkillGapPanel
          data={fixture({ gaps: [gap('Kafka', 1, 90), gap('Go', 0, 40)] })}
          onPickSkill={vi.fn()}
        />,
      );

      // 1/90 is 1.1% — under a pixel on any real width, so it gets a 2% floor.
      expect(widths(screen.getByRole('button', { name: /Kafka/ })).fill).toBe(2);

      // Zero keeps zero. A sliver here would draw a near miss the text beside it
      // correctly denies.
      expect(widths(screen.getByRole('button', { name: /Go/ })).fill).toBe(0);
    });

    it('draws a solid bar when fill and track coincide', () => {
      renderApp(
        <SkillGapPanel data={fixture({ gaps: [gap('Kafka', 7, 7)] })} onPickSkill={vi.fn()} />,
      );

      const { track, fill } = widths(screen.getByRole('button', { name: /Kafka/ }));
      expect(fill).toBe(track);
      expect(track).toBe(100);
    });
  });
});

describe('SkillGapPanelSkeleton', () => {
  it('is hidden from assistive technology', () => {
    const { container } = renderApp(<SkillGapPanelSkeleton />);

    // It reserves 54px of height and says nothing. A screen reader announcing a
    // placeholder is worse than it announcing nothing and then the panel.
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
  });
});
