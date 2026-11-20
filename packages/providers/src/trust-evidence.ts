import type { Job, JobTrustEvidence, SourceId } from '@careerscope/shared';

type SourceLink = { source: SourceId; url: string };

/**
 * Build factual evidence from a normalized listing. Provider statements stay
 * labeled as reported, observed values are limited to the URLs CareerScope
 * received, and missing fields stay explicit. This function performs no
 * network, DNS, ownership, or fraud checks.
 */
export function buildJobTrustEvidence(
  job: Job,
  sourceLinks: readonly SourceLink[] = [],
): JobTrustEvidence[] {
  const listingLinks = new Map<string, SourceLink>();
  for (const link of [{ source: job.source, url: job.sourceUrl }, ...sourceLinks]) {
    const current = listingLinks.get(link.source);
    if (!current || link.url.localeCompare(current.url) < 0) listingLinks.set(link.source, link);
  }

  const entries: JobTrustEvidence[] = [...listingLinks.values()]
    .sort((left, right) => left.source.localeCompare(right.source))
    .map(({ source, url }) => ({
      kind: 'source_listing',
      status: 'observed',
      source,
      referenceUrl: url,
      value: null,
    }));

  const addClaim = (kind: JobTrustEvidence['kind'], value: string | null, referenceUrl: string) => {
    const boundedValue = value?.slice(0, 500) ?? null;
    entries.push({
      kind,
      status: boundedValue === null ? 'not_provided' : 'provider_reported',
      source: job.source,
      referenceUrl,
      value: boundedValue,
    });
  };

  addClaim('publisher_attribution', job.sourcePublisher, job.sourceUrl);
  addClaim('employer_website_claim', host(job.company.website), job.sourceUrl);
  addClaim('careers_website_claim', host(job.company.careersUrl), job.sourceUrl);

  const applicationHost = new URL(job.applyUrl).host.toLowerCase();
  entries.push({
    kind: 'application_destination',
    status: 'observed',
    source: job.source,
    referenceUrl: job.applyUrl,
    value: applicationHost,
  });

  addClaim('posted_date_claim', job.postedAt, job.sourceUrl);

  entries.push({
    kind: 'description_availability',
    status: 'observed',
    source: job.source,
    referenceUrl: job.sourceUrl,
    value: job.hasFullDescription
      ? 'full'
      : job.descriptionText.trim().length > 0
        ? 'partial'
        : 'missing',
  });

  return entries;
}

function host(value: string | null): string | null {
  if (value === null) return null;
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}
