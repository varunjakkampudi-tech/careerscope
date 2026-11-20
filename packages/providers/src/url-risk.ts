import { isIP } from 'node:net';
import type { UrlRiskIndicator } from '@careerscope/shared';

const URL_SHORTENERS = [
  'bit.ly',
  'cutt.ly',
  'is.gd',
  'lnkd.in',
  'ow.ly',
  'rebrand.ly',
  't.co',
  'tinyurl.com',
  't.ly',
] as const;

const REDIRECT_PARAMETER_NAMES = new Set([
  'continue',
  'continueurl',
  'destination',
  'next',
  'redirect',
  'redirecturl',
  'redirecturi',
  'return',
  'returnto',
  'returnurl',
  'target',
  'url',
]);

/**
 * Return deterministic, explainable URL indicators for the link a candidate
 * would use. These are review signals, not a verdict that a URL or job is
 * malicious. No request, DNS lookup, or redirect is followed.
 */
export function detectUrlRiskIndicators(
  rawApplyUrl: string | undefined,
  sourceUrl: string,
): UrlRiskIndicator[] {
  const indicators = new Set<UrlRiskIndicator>();
  const rawApply = rawApplyUrl?.trim();
  const applyUrl = rawApply || sourceUrl;

  inspectUrl(applyUrl, indicators);

  // Invalid application URLs are discarded by normalization in favor of the
  // provider listing. Preserve that fact without treating the fallback as the
  // invalid URL itself.
  if (rawApply && !isSupportedWebUrl(rawApply)) {
    indicators.add('invalid_url');
    inspectUrl(sourceUrl, indicators);
  }

  return [...indicators].sort();
}

function isSupportedWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function inspectUrl(value: string, indicators: Set<UrlRiskIndicator>): void {
  if (value.length > 4096) {
    indicators.add('invalid_url');
    return;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    indicators.add('invalid_url');
    return;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    indicators.add('unsupported_scheme');
    return;
  }
  if (url.protocol === 'http:') indicators.add('http_transport');
  if (url.username || url.password) indicators.add('embedded_credentials');

  // WHATWG URL canonicalization removes an explicit default port. Any
  // remaining port is non-standard for public application links.
  if (url.port) indicators.add('nonstandard_port');

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(hostname) !== 0) indicators.add('ip_literal_host');
  if (hostname.split('.').some((label) => label.startsWith('xn--'))) {
    indicators.add('punycode_host');
  }
  if (URL_SHORTENERS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
    indicators.add('url_shortener');
  }

  for (const [name, rawTarget] of url.searchParams) {
    const normalizedName = name.toLowerCase().replace(/[-_]/g, '');
    if (!REDIRECT_PARAMETER_NAMES.has(normalizedName)) continue;
    try {
      const target = new URL(rawTarget, url.origin);
      if (
        (target.protocol === 'http:' || target.protocol === 'https:') &&
        target.hostname.toLowerCase() !== hostname
      ) {
        indicators.add('external_redirect_parameter');
      }
    } catch {
      // A parameter that is not an absolute URL is not enough evidence to flag.
    }
  }
}
