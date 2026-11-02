/**
 * Re-acceptance of changed terms and privacy versions (item 2.11). An account that accepted an
 * earlier version must accept the current one before it can change anything. An account with no
 * recorded acceptance is not forced, because it predates the record.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Database } from './database.js';

export type LegalPolicy = { termsVersion: string; privacyVersion: string };

export type LegalStatus = {
  required: boolean;
  acceptedTermsVersion: string | null;
  acceptedPrivacyVersion: string | null;
};

/** The latest recorded acceptance of each document, from the append-only ledger. */
async function latestAcceptances(queryable: Pick<Pool, 'query'>, ownerId: string) {
  const result = await queryable.query<{
    document: string;
    version: string;
    accepted: boolean;
  }>(
    `SELECT DISTINCT ON (document) document, version, accepted
     FROM account_acceptances
     WHERE owner_id = $1 AND document IN ('terms', 'privacy_notice')
     ORDER BY document, sequence DESC`,
    [ownerId],
  );
  const byDocument = new Map(result.rows.map((row) => [row.document, row]));
  return {
    terms: byDocument.get('terms') ?? null,
    privacy: byDocument.get('privacy_notice') ?? null,
  };
}

/** Whether the account must accept the current versions before it can change anything. */
export async function legalStatus(
  database: Database,
  ownerId: string,
  policy: LegalPolicy,
): Promise<LegalStatus> {
  const latest = await latestAcceptances(database.pool, ownerId);
  const current = (row: { version: string; accepted: boolean } | null, version: string) =>
    row !== null && row.accepted && row.version === version;
  // Only a recorded earlier version triggers the requirement. A missing record does not.
  const stale = (row: { version: string; accepted: boolean } | null, version: string) =>
    row !== null && !current(row, version);
  return {
    required:
      stale(latest.terms, policy.termsVersion) || stale(latest.privacy, policy.privacyVersion),
    acceptedTermsVersion: latest.terms?.accepted ? latest.terms.version : null,
    acceptedPrivacyVersion: latest.privacy?.accepted ? latest.privacy.version : null,
  };
}

/**
 * Records acceptance of the current versions. Only documents whose latest record differs are
 * written, so repeated acceptance does not grow the ledger.
 */
export async function recordLegalAcceptance(
  database: Database,
  ownerId: string,
  policy: LegalPolicy,
): Promise<void> {
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [ownerId]);
    // Read on the locked transaction, so the decision and the insert see the same ledger.
    const latest = await latestAcceptances(client, ownerId);
    const documents = [
      { document: 'terms', version: policy.termsVersion, row: latest.terms },
      { document: 'privacy_notice', version: policy.privacyVersion, row: latest.privacy },
    ];
    for (const { document, version, row } of documents) {
      if (row?.accepted && row.version === version) continue;
      await client.query(
        `INSERT INTO account_acceptances (id, owner_id, document, version, accepted)
         VALUES ($1, $2, $3, $4, true)`,
        [randomUUID(), ownerId, document, version],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
