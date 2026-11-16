/**
 * Bounded, offline reader for employer-supplied Schema.org JobPosting JSON-LD.
 * This module does not discover URLs, make requests, or establish permission to
 * collect or display a posting. Callers must supply an authorized HTML snapshot.
 */

import { descriptionToText, decodeEntities, tidyText } from './html.js';

export interface CareerMarkupJob {
  title: string;
  companyName: string;
  sourceUrl: string;
  description?: string;
  location?: string;
  isRemote?: boolean;
  employmentType?: string;
  postedAt?: string;
  validThrough?: string;
}

const MAX_HTML_CHARS = 2_000_000;
const MAX_SCRIPT_CHARS = 500_000;
const MAX_POSTINGS = 1_000;
const JSON_LD_TYPE =
  /\btype\s*=\s*(?:"application\/ld\+json"|'application\/ld\+json'|application\/ld\+json)(?=\s|\/|$)/i;

/** Extract valid JobPosting records from an already-authorized HTML document. */
export function readJobPostingMarkup(html: string, pageUrl: string): CareerMarkupJob[] {
  if (html.length > MAX_HTML_CHARS || !validHttpUrl(pageUrl)) return [];
  const page = new URL(pageUrl);
  const results: CareerMarkupJob[] = [];
  for (const content of jsonLdScripts(html)) {
    if (content.length > MAX_SCRIPT_CHARS) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(content.trim());
    } catch {
      continue;
    }
    for (const node of jobPostingNodes(parsed)) {
      if (results.length >= MAX_POSTINGS) return results;
      const job = toJob(node, page);
      if (job) results.push(job);
    }
  }
  return results;
}

/** Scans script elements by monotonically advancing indices to keep hostile HTML work linear. */
function* jsonLdScripts(html: string): Generator<string> {
  const lower = html.toLowerCase();
  let cursor = 0;
  while (cursor < html.length) {
    const start = lower.indexOf('<script', cursor);
    if (start < 0) return;
    const nameEnd = start + '<script'.length;
    const boundary = html[nameEnd];
    if (boundary !== '>' && boundary !== '/' && boundary !== undefined && !/\s/.test(boundary)) {
      cursor = nameEnd;
      continue;
    }
    const openEnd = findTagEnd(html, nameEnd);
    if (openEnd < 0) return;
    let closeStart = lower.indexOf('</script', openEnd + 1);
    while (
      closeStart >= 0 &&
      html[closeStart + '</script'.length] !== '>' &&
      !/\s/.test(html[closeStart + '</script'.length] ?? '')
    ) {
      closeStart = lower.indexOf('</script', closeStart + 1);
    }
    if (closeStart < 0) return;
    const closeEnd = html.indexOf('>', closeStart + '</script'.length);
    if (closeEnd < 0) return;
    if (JSON_LD_TYPE.test(html.slice(nameEnd, openEnd))) yield html.slice(openEnd + 1, closeStart);
    cursor = closeEnd + 1;
  }
}

/** Finds a tag terminator while respecting quoted attribute values. */
function findTagEnd(html: string, start: number): number {
  let quote = '';
  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '>') return index;
  }
  return -1;
}

function validHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

function* jobPostingNodes(value: unknown): Generator<Record<string, unknown>> {
  const pending: unknown[] = [value];
  let inspected = 0;
  while (pending.length && inspected < MAX_POSTINGS * 10) {
    const current = pending.pop();
    inspected += 1;
    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) pending.push(current[index]);
      continue;
    }
    if (!current || typeof current !== 'object') continue;
    const record = current as Record<string, unknown>;
    const type = record['@type'];
    const types = Array.isArray(type) ? type : [type];
    if (
      types.some(
        (candidate) =>
          candidate === 'JobPosting' ||
          candidate === 'http://schema.org/JobPosting' ||
          candidate === 'https://schema.org/JobPosting',
      )
    )
      yield record;
    if (record['@graph'] !== undefined) pending.push(record['@graph']);
  }
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string') return tidyText(decodeEntities(value)) || undefined;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.name === 'string') return tidyText(decodeEntities(record.name)) || undefined;
  }
  return undefined;
}

function employmentTypeText(value: unknown): string | undefined {
  const values = Array.isArray(value) ? value : [value];
  const normalized = values
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => tidyText(decodeEntities(entry)))
    .filter(Boolean);
  return normalized.length ? normalized.join(', ') : undefined;
}

function toJob(node: Record<string, unknown>, page: URL): CareerMarkupJob | null {
  const title = text(node.title);
  const organization = node.hiringOrganization;
  const companyName = text(organization);
  if (!title || !companyName) return null;

  const urlValue = text(node.url) ?? page.href;
  let sourceUrl: URL;
  try {
    sourceUrl = new URL(urlValue, page);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(sourceUrl.protocol) || sourceUrl.username || sourceUrl.password)
    return null;

  const jobLocationType = text(node.jobLocationType)?.toUpperCase();
  const isRemote = jobLocationType === 'TELECOMMUTE' ? true : undefined;
  const location = locationText(node.jobLocation);
  const description =
    typeof node.description === 'string'
      ? descriptionToText(node.description, true).slice(0, 100_000) || undefined
      : undefined;
  return {
    title,
    companyName,
    sourceUrl: sourceUrl.href,
    ...(description ? { description } : {}),
    ...(location ? { location } : {}),
    ...(isRemote ? { isRemote } : {}),
    ...(employmentTypeText(node.employmentType)
      ? { employmentType: employmentTypeText(node.employmentType) }
      : {}),
    ...(text(node.datePosted) ? { postedAt: text(node.datePosted) } : {}),
    ...(text(node.validThrough) ? { validThrough: text(node.validThrough) } : {}),
  };
}

function locationText(value: unknown): string | undefined {
  const entries = Array.isArray(value) ? value : [value];
  const names = entries.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const address = (entry as Record<string, unknown>).address;
    if (typeof address === 'string') return [tidyText(decodeEntities(address))];
    if (!address || typeof address !== 'object') return [];
    const record = address as Record<string, unknown>;
    const parts = [record.addressLocality, record.addressRegion, record.addressCountry]
      .map(text)
      .filter((part): part is string => Boolean(part));
    return parts.length ? [parts.join(', ')] : [];
  });
  return names.length ? names.join(' / ') : undefined;
}
