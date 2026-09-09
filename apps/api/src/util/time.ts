/**
 * Time.
 *
 * Every timestamp crossing a boundary — into SQLite, into JSON, into the export
 * — is an ISO-8601 string in UTC. SQLite has no date type, so a string is what
 * gets stored regardless; making it the type everywhere means there is no
 * conversion layer to get wrong, and `ORDER BY posted_at DESC` sorts correctly
 * because ISO-8601 sorts lexicographically.
 *
 * `now()` is a function rather than a value so tests can pass a fixed clock;
 * every repository and service takes the timestamp as an argument for the same
 * reason.
 */

export function now(): string {
  return new Date().toISOString();
}

export function daysAgo(days: number, from = new Date()): string {
  return new Date(from.getTime() - days * 86_400_000).toISOString();
}
