import type { SourceId, SourceUrlVerification } from '@careerscope/shared';

interface HostRule {
  hostname: string;
  includeSubdomains?: boolean;
}

/**
 * Hosts used by the adapters' canonical listing URLs. A positive result means
 * only that the URL hostname matches this local adapter configuration.
 */
const HOST_RULES: Partial<Record<SourceId, readonly HostRule[]>> = {
  greenhouse: [{ hostname: 'boards.greenhouse.io' }, { hostname: 'job-boards.greenhouse.io' }],
  lever: [{ hostname: 'jobs.lever.co' }],
  ashby: [{ hostname: 'jobs.ashbyhq.com' }],
  workable: [{ hostname: 'apply.workable.com' }],
  smartrecruiters: [{ hostname: 'jobs.smartrecruiters.com' }],
  recruitee: [{ hostname: 'jobs.recruitee.com' }],
  remoteok: [{ hostname: 'remoteok.com', includeSubdomains: true }],
  remotive: [{ hostname: 'remotive.com', includeSubdomains: true }],
  himalayas: [{ hostname: 'himalayas.app', includeSubdomains: true }],
  linkedin: [{ hostname: 'linkedin.com', includeSubdomains: true }],
  naukri: [{ hostname: 'naukri.com', includeSubdomains: true }],
  indeed: [
    { hostname: 'indeed.com', includeSubdomains: true },
    { hostname: 'indeed.co.in', includeSubdomains: true },
    { hostname: 'indeed.co.uk', includeSubdomains: true },
    { hostname: 'indeed.ca', includeSubdomains: true },
    { hostname: 'indeed.com.au', includeSubdomains: true },
  ],
};

function hostMatches(hostname: string, rule: HostRule): boolean {
  return (
    hostname === rule.hostname ||
    (rule.includeSubdomains === true && hostname.endsWith('.' + rule.hostname))
  );
}

/**
 * Checks source attribution against configured listing hosts without network
 * access. Unknown/third-party destinations are preserved as unverified.
 */
export function verifySourceUrl(source: SourceId, input: string): SourceUrlVerification {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { status: 'unverified', reason: 'invalid_url' };
  }

  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.port) {
    return { status: 'unverified', reason: 'invalid_url' };
  }
  if (url.username || url.password) {
    return { status: 'unverified', reason: 'credentials_present' };
  }

  const rules = HOST_RULES[source];
  if (!rules) return { status: 'unverified', reason: 'unconfigured_source' };
  if (rules.some((rule) => hostMatches(url.hostname, rule))) {
    return { status: 'configured_host_match', reason: 'host_match' };
  }

  const belongsToAnotherConfiguredSource = Object.entries(HOST_RULES).some(
    ([configuredSource, configuredRules]) =>
      configuredSource !== source &&
      (configuredRules ?? []).some((rule) => hostMatches(url.hostname, rule)),
  );
  if (belongsToAnotherConfiguredSource) {
    return { status: 'unverified', reason: 'host_mismatch' };
  }
  return { status: 'unverified', reason: 'host_not_configured' };
}
