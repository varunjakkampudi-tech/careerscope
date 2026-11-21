export type JobSortMode = 'match' | 'evidence' | 'newest';

export interface SortableSearchJob {
  id: string;
  data: {
    title: string;
    postedAt: string | null;
    match?: {
      score: number;
      confidence: 'high' | 'low';
    } | null;
  };
}

/** Sort a copy so callers can safely reuse cached API result arrays. */
export function sortSearchJobs<T extends SortableSearchJob>(
  jobs: readonly T[],
  mode: JobSortMode,
): T[] {
  return [...jobs].sort((a, b) => {
    if (mode === 'evidence') {
      const confidence = Number(b.data.match?.confidence === 'high') - Number(a.data.match?.confidence === 'high');
      if (confidence) return confidence;
    }

    if (mode === 'newest') {
      const date = timestamp(b.data.postedAt) - timestamp(a.data.postedAt);
      if (date) return date;
    }

    const score = (b.data.match?.score ?? -1) - (a.data.match?.score ?? -1);
    if (score) return score;

    if (mode !== 'newest') {
      const date = timestamp(b.data.postedAt) - timestamp(a.data.postedAt);
      if (date) return date;
    }

    return compareText(a.data.title, b.data.title) || compareText(a.id, b.id);
  });
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function timestamp(value: string | null): number {
  if (value === null) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}
