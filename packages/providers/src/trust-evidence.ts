import type { Job, JobTrustEvidence, SourceId } from '@careerscope/shared';

type SourceLink = { source: SourceId; url: string };

/**
 * Build factual evidence from a normalized listing. Provider statements stay
 * labeled as reported, observed values are limited to the URLs CareerScope
 * received, and missing fields stay explicit. This function performs no
 * network, DNS, ownership, or fraud checks. Application destinations must be
 * passed separately so a normalized navigation fallback is never treated as
 * an observed destination.
 */
export function buildJobTrustEvidence(
  job: Job,
  sourceLinks: readonly SourceLink[] = [],
  applicationDestinations: readonly SourceLink[] = [],
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

  const destinationsBySource = new Map<SourceId, Map<string, SourceLink>>();
  for (const destination of applicationDestinations) {
    const destinations = destinationsBySource.get(destination.source) ?? new Map();
    destinations.set(destination.url, destination);
    destinationsBySource.set(destination.source, destinations);
  }
  for (const { source, url: listingUrl } of [...listingLinks.values()].sort((left, right) =>
    left.source.localeCompare(right.source),
  )) {
    const destinations = [...(destinationsBySource.get(source)?.values() ?? [])].sort(
      (left, right) => left.url.localeCompare(right.url),
    );
    if (destinations.length === 0) {
      entries.push({
        kind: 'application_destination',
        status: 'not_provided',
        source,
        referenceUrl: listingUrl,
        value: null,
      });
      continue;
    }
    for (const { url } of destinations) {
      entries.push({
        kind: 'application_destination',
        status: 'observed',
        source,
        referenceUrl: url,
        value: new URL(url).host.toLowerCase(),
      });
    }
  }

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
