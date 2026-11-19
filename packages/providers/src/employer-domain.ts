import type { EmployerDomainCheck } from '@careerscope/shared';

const ATS_HOSTS = [
  'boards.greenhouse.io',
  'job-boards.greenhouse.io',
  'jobs.lever.co',
  'jobs.ashbyhq.com',
  'apply.workable.com',
  'jobs.smartrecruiters.com',
  'jobs.recruitee.com',
] as const;

/**
 * Compare only the hosts supplied by the source. This is a consistency signal,
 * not proof that either host belongs to the named employer.
 */
export function checkEmployerDomain(
  companyWebsite: string | null | undefined,
  applyUrl: string | null | undefined,
): EmployerDomainCheck {
  const companyHost = normalizedHost(companyWebsite);
  const applyHost = normalizedHost(applyUrl);
  if (!applyHost) {
    return { status: 'unknown', companyHost, applyHost };
  }

  if (ATS_HOSTS.some((host) => applyHost === host || applyHost.endsWith(`.${host}`))) {
    return { status: 'ats-hosted', companyHost, applyHost };
  }

  if (!companyHost) {
    return { status: 'unknown', companyHost, applyHost };
  }

  return {
    status: companyHost === applyHost ? 'same-host' : 'different-host',
    companyHost,
    applyHost,
  };
}

function normalizedHost(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
      return null;
    }
    return url.hostname.toLowerCase().replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}
