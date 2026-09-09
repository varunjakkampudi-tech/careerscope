/**
 * Identifiers.
 *
 * Two rules the rest of the app depends on:
 *
 *  - **Nothing user-controlled ever becomes a filesystem path.** An uploaded
 *    resume is stored under `newId()`, never under its own filename — the
 *    browser sends that string and `../../.ssh/id_rsa` is a legal value for it.
 *  - **Job and company ids are derived, not generated.** `packages/providers`
 *    already computes a stable fingerprint and company slug, so the same posting
 *    seen on two boards lands on one row. Only rows with no natural key — runs,
 *    leads, resumes, profiles — get a random id from here.
 */

import { randomUUID } from 'node:crypto';

export function newId(): string {
  return randomUUID();
}

/**
 * A readable id with a type prefix, for anything that shows up in a URL or a log
 * line. `run_3f1c…` in an error report says what it is without a lookup.
 */
export function prefixedId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

/** The single profile of a single-user install. */
export const LOCAL_PROFILE_ID = 'local';
/** The `user_id` written to every user-scoped table until multi-user lands. */
export const LOCAL_USER_ID = 'local';

/**
 * Strips a filename down to something safe to keep as a *label*. This is not
 * what the file is stored as — that is always `newId()` — but the original name
 * is shown in the UI and written into the export, so it still has to be inert.
 */
export function safeFilename(name: string, fallback = 'resume'): string {
  const base = name.split(/[/\\]/).pop() ?? '';
  const cleaned = base
    // Control characters go first: they would otherwise survive as literal bytes
    // and can break a Content-Disposition header or a terminal that prints them.
    // eslint-disable-next-line no-control-regex -- matching them is the point.
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    // A leading dot makes a hidden file, and ".." is a traversal segment.
    .replace(/^\.+/, '')
    .slice(0, 120);
  return cleaned || fallback;
}
