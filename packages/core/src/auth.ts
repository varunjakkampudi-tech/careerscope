/**
 * Account sessions and credentials: opaque access and refresh tokens, Argon2 passwords, CSRF
 * derivation and session management. Only SHA-256 digests of tokens are stored. Used by the API auth
 * routes with `database.ts`, `email-otp-challenges.ts` and `test-users.ts`.
 */

import { rollback } from './rollback.js';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { z } from 'zod';
import type { Database } from './database.js';
import { testUsers } from './test-users.js';

/** Cookie names and token lifetimes. The access token is short-lived (15 minutes); the refresh token lasts 30 days and is single use. */
export const sessionCookie = 'careerscope_v2_session';
export const refreshCookie = 'careerscope_v2_refresh';
export const accessSessionLifetimeSeconds = 15 * 60;
export const refreshSessionLifetimeSeconds = 30 * 24 * 60 * 60;
/** SHA-256 hex digest. Tokens are 256-bit random values, so an unsalted hash is enough to avoid storing them in the clear. */
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
/** Argon2 hash with explicit cost settings (about 19 MiB memory, 2 passes, 1 lane). */
export const passwordHash = (password: string) =>
  hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 });

/** A freshly issued session: both tokens (returned once, never stored) and the session id. */
export type SessionCredentials = {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
};

/** Tokens the browser already holds; `createSession` revokes them so a re-login does not leave the old session live. */
export type PreviousSession = { accessToken?: string; refreshToken?: string };

/** Authentication service backed by the `users`, `sessions` and `session_refresh_tokens` tables. */
export class Auth {
  // Verified against when the email is unknown, so unknown and wrong-password logins take similar time.
  private readonly dummyHash = passwordHash(randomBytes(32).toString('hex'));

  constructor(private readonly database: Database) {}

  // Must run inside the caller's transaction so the revoke of the previous session and the insert of
  // the new one commit together.
  private async createSession(
    client: import('pg').PoolClient,
    ownerId: string,
    previous?: PreviousSession,
    deviceLabel?: string,
  ): Promise<SessionCredentials> {
    // Expired sessions and their refresh-token digests (kept for replay detection)
    // are no longer usable; delete them here to bound retained auth data.
    await client.query('DELETE FROM sessions WHERE expires_at <= now()');
    const sessionId = randomUUID();
    const accessToken = randomBytes(32).toString('hex');
    const refreshToken = randomBytes(32).toString('hex');
    const previousAccess = previous?.accessToken ? digest(previous.accessToken) : null;
    const previousRefresh = previous?.refreshToken ? digest(previous.refreshToken) : null;
    await client.query(
      `UPDATE sessions SET revoked_at = COALESCE(revoked_at, now())
       WHERE ($1::text IS NOT NULL AND token_hash = $1)
          OR ($2::text IS NOT NULL AND id IN (
            SELECT session_id FROM session_refresh_tokens WHERE token_hash = $2
          ))`,
      [previousAccess, previousRefresh],
    );
    await client.query(
      `INSERT INTO sessions
         (id, token_hash, owner_id, expires_at, access_expires_at, created_at, last_used_at, device_label)
       VALUES ($1, $2, $3, now() + interval '30 days', now() + interval '15 minutes', now(), now(), $4)`,
      [sessionId, digest(accessToken), ownerId, deviceLabel ?? null],
    );
    await client.query(
      `INSERT INTO session_refresh_tokens (token_hash, session_id, expires_at)
       SELECT $1, id, expires_at FROM sessions WHERE id = $2`,
      [digest(refreshToken), sessionId],
    );
    return { accessToken, refreshToken, sessionId };
  }

  /** Inserts a password account. A duplicate email is silently ignored, so the response does not reveal whether it exists. */
  async register(email: string, password: string): Promise<void> {
    const normalized = z.string().email().max(254).parse(email.trim().toLowerCase());
    z.string().min(12).max(256).parse(password);
    const hashed = await passwordHash(password);
    await this.database.pool.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO NOTHING`,
      [randomUUID(), normalized, hashed],
    );
  }

  /**
   * Creates the first account for a fresh install. The exclusive table lock makes the empty-table check
   * and the insert atomic, so two concurrent calls cannot both create a first user.
   */
  async createOwner(email: string, password: string) {
    const normalized = z.string().email().max(254).parse(email.trim().toLowerCase());
    z.string().min(12).max(256).parse(password);
    const hashed = await passwordHash(password);
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('LOCK TABLE users IN EXCLUSIVE MODE');
      const existing = await client.query('SELECT id FROM users LIMIT 1');
      if (existing.rowCount) throw new Error('Owner already configured');
      await client.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [
        randomUUID(),
        normalized,
        hashed,
      ]);
      await client.query('COMMIT');
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Password login. Returns null for an unknown email or wrong password. The password is verified
   * first, then the user row is locked and the stored hash re-read, so a password change that lands in between rejects the login.
   */
  async loginSession(
    email: string,
    password: string,
    previous?: PreviousSession,
    deviceLabel?: string,
  ): Promise<SessionCredentials | null> {
    const result = await this.database.pool.query<{ id: string; password_hash: string }>(
      'SELECT id, password_hash FROM users WHERE email = $1',
      [email.toLowerCase().trim()],
    );
    const user = result.rows[0];
    const valid = await verify(user?.password_hash ?? (await this.dummyHash), password);
    if (!user || !valid) return null;
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query<{ password_hash: string }>(
        'SELECT password_hash FROM users WHERE id = $1 FOR UPDATE',
        [user.id],
      );
      if (current.rows[0]?.password_hash !== user.password_hash) {
        await rollback(client);
        return null;
      }
      const credentials = await this.createSession(client, user.id, previous, deviceLabel);
      await client.query('COMMIT');
      return credentials;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Convenience wrapper that returns only the access token, for domain tests. HTTP authentication uses both tokens. */
  async login(email: string, password: string, previous?: string) {
    const credentials = await this.loginSession(
      email,
      password,
      previous ? { accessToken: previous } : undefined,
    );
    return credentials?.accessToken ?? null;
  }

  /** Establishes the existing opaque session only for an existing email identity. */
  async loginWithVerifiedEmail(
    email: string,
    previous?: PreviousSession,
    deviceLabel?: string,
  ): Promise<SessionCredentials | null> {
    const normalized = z.string().email().max(254).parse(email.trim().toLowerCase());
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const credentials = await this.loginWithVerifiedEmailInTransaction(
        client,
        normalized,
        previous,
        deviceLabel,
      );
      if (!credentials) {
        await rollback(client);
        return null;
      }
      await client.query('COMMIT');
      return credentials;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /** As `loginWithVerifiedEmail` on the caller's transaction, so the code consumption and session creation commit together. Marks the email verified. */
  async loginWithVerifiedEmailInTransaction(
    client: import('pg').PoolClient,
    email: string,
    previous?: PreviousSession,
    deviceLabel?: string,
  ): Promise<SessionCredentials | null> {
    const normalized = z.string().email().max(254).parse(email.trim().toLowerCase());
    const user = await client.query<{ id: string }>(
      'SELECT id FROM users WHERE email = $1 FOR UPDATE',
      [normalized],
    );
    if (!user.rows[0]) return null;
    await client.query(
      'UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1',
      [user.rows[0].id],
    );
    return this.createSession(client, user.rows[0].id, previous, deviceLabel);
  }

  /**
   * Returns a session for a verified email, creating the account and recording consent if it is new.
   * If another request created the account first, this logs in to that account and does not write
   * consent from the losing request. Must run in the caller's transaction.
   */
  async createOtpAccountInTransaction(
    client: import('pg').PoolClient,
    email: string,
    acceptance: {
      termsVersion: string;
      privacyVersion: string;
      ageScreenPassed: true;
      marketingOptIn: boolean;
      marketingVersion?: string;
    },
    previous?: PreviousSession,
    deviceLabel?: string,
  ): Promise<SessionCredentials> {
    const normalized = z.string().email().max(254).parse(email.trim().toLowerCase());
    const existing = await client.query<{ id: string }>(
      'SELECT id FROM users WHERE email = $1 FOR UPDATE',
      [normalized],
    );
    if (existing.rows[0]) {
      const credentials = await this.loginWithVerifiedEmailInTransaction(
        client,
        normalized,
        previous,
        deviceLabel,
      );
      if (!credentials) throw new Error('Verified account could not establish a session');
      return credentials;
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO users (id, email, email_verified_at, age_screen_passed, password_hash)
       VALUES ($1, $2, now(), $3, NULL)
       ON CONFLICT (email) DO NOTHING
       RETURNING id`,
      [randomUUID(), normalized, acceptance.ageScreenPassed],
    );
    if (!inserted.rows[0]) {
      // A concurrent account creator won the unique-email race. Treat it as an
      // existing identity: do not rewrite or append consent based on the losing
      // request's signup payload.
      const credentials = await this.loginWithVerifiedEmailInTransaction(
        client,
        normalized,
        previous,
        deviceLabel,
      );
      if (!credentials) throw new Error('Concurrent OTP account could not establish a session');
      return credentials;
    }
    const ownerId = inserted.rows[0].id;
    if (!ownerId) throw new Error('OTP account finalization did not persist an owner');

    const records = [
      { document: 'terms', version: acceptance.termsVersion, accepted: true },
      { document: 'privacy_notice', version: acceptance.privacyVersion, accepted: true },
      ...(acceptance.marketingOptIn && acceptance.marketingVersion
        ? [{ document: 'marketing', version: acceptance.marketingVersion, accepted: true }]
        : []),
    ];
    for (const record of records) {
      await client.query(
        `INSERT INTO account_acceptances (id, owner_id, document, version, accepted)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), ownerId, record.document, record.version, record.accepted],
      );
    }
    return this.createSession(client, ownerId, previous, deviceLabel);
  }

  /**
   * Session for one of the fixed `testUsers`; no password. Callers must gate this with
   * `testAccessAllowed`. Throws if the email exists under a different id.
   */
  async testLoginSession(
    email: string,
    previous?: PreviousSession,
    deviceLabel?: string,
  ): Promise<SessionCredentials | null> {
    const normalized = email.toLowerCase().trim();
    const account = testUsers.find((user) => user.email === normalized);
    if (!account) return null;
    // Auto-create user if they don't exist (no password required for test mode)
    const existing = await this.database.pool.query<{ id: string }>(
      'SELECT id FROM users WHERE email = $1',
      [normalized],
    );
    let userId: string;
    if (existing.rows[0]) {
      if (existing.rows[0].id !== account.id)
        throw new Error('Test identity conflicts with an existing account');
      userId = account.id;
    } else {
      userId = account.id;
      const dummyHash = await passwordHash(randomBytes(32).toString('hex'));
      await this.database.pool.query(
        `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)
         ON CONFLICT (email) DO NOTHING`,
        [userId, normalized, dummyHash],
      );
      // Re-fetch in case of race condition
      const refetch = await this.database.pool.query<{ id: string }>(
        'SELECT id FROM users WHERE email = $1',
        [normalized],
      );
      if (!refetch.rows[0] || refetch.rows[0].id !== account.id) return null;
      userId = refetch.rows[0].id;
    }
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const credentials = await this.createSession(client, userId, previous, deviceLabel);
      await client.query('COMMIT');
      return credentials;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Test-account counterpart of `login`: returns only the access token, for domain tests. */
  async testLogin(email: string, previous?: string) {
    const credentials = await this.testLoginSession(
      email,
      previous ? { accessToken: previous } : undefined,
    );
    return credentials?.accessToken ?? null;
  }

  /** CSRF token bound to the access token, so it changes whenever the access token is rotated. */
  csrfForAccessToken(token: string) {
    return digest(`csrf:${token}`);
  }

  /** Resolves an access token to a live session (not expired, not revoked), or null. Malformed tokens are rejected before any query. */
  async session(token?: string) {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const result = await this.database.pool.query<{ id: string; owner_id: string }>(
      `SELECT id, owner_id FROM sessions
       WHERE token_hash = $1 AND access_expires_at > now() AND expires_at > now()
         AND revoked_at IS NULL`,
      [digest(token)],
    );
    const session = result.rows[0];
    return session
      ? { sessionId: session.id, ownerId: session.owner_id, csrf: this.csrfForAccessToken(token) }
      : null;
  }

  /**
   * Rotates a refresh token. Each token works once: presenting a consumed one means it was replayed,
   * so the whole session is revoked and `reused` is returned. Rows are locked with FOR UPDATE so
   * concurrent refreshes cannot both succeed.
   */
  async refresh(
    token?: string,
  ): Promise<
    | { status: 'rotated'; ownerId: string; credentials: SessionCredentials }
    | { status: 'reused'; sessionId: string }
    | { status: 'invalid' }
  > {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return { status: 'invalid' };
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query<{
        session_id: string;
        owner_id: string;
        consumed_at: Date | null;
        session_expires_at: Date;
        revoked_at: Date | null;
        unexpired: boolean;
      }>(
        `SELECT rt.session_id, s.owner_id, rt.consumed_at,
                s.expires_at AS session_expires_at, s.revoked_at,
                (rt.expires_at > now() AND s.expires_at > now()) AS unexpired
         FROM session_refresh_tokens rt
         JOIN sessions s ON s.id = rt.session_id
         WHERE rt.token_hash = $1
         FOR UPDATE OF rt, s`,
        [digest(token)],
      );
      const current = found.rows[0];
      if (!current) {
        await rollback(client);
        return { status: 'invalid' };
      }
      if (current.consumed_at) {
        await client.query(
          'UPDATE sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1',
          [current.session_id],
        );
        await client.query('COMMIT');
        return { status: 'reused', sessionId: current.session_id };
      }
      if (current.revoked_at || !current.unexpired) {
        await rollback(client);
        return { status: 'invalid' };
      }
      const accessToken = randomBytes(32).toString('hex');
      const refreshToken = randomBytes(32).toString('hex');
      await client.query(
        'UPDATE session_refresh_tokens SET consumed_at = now() WHERE token_hash = $1',
        [digest(token)],
      );
      await client.query(
        `UPDATE sessions SET token_hash = $1,
            access_expires_at = now() + interval '15 minutes', last_used_at = now()
         WHERE id = $2`,
        [digest(accessToken), current.session_id],
      );
      await client.query(
        `INSERT INTO session_refresh_tokens (token_hash, session_id, expires_at)
         VALUES ($1, $2, $3)`,
        [digest(refreshToken), current.session_id, current.session_expires_at],
      );
      await client.query('COMMIT');
      return {
        status: 'rotated',
        ownerId: current.owner_id,
        credentials: { accessToken, refreshToken, sessionId: current.session_id },
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Constant-time comparison of the expected CSRF value with the one provided; format is checked first because the comparison needs equal lengths. */
  validCsrf(expected: string, provided: unknown) {
    return (
      typeof provided === 'string' &&
      /^[a-f0-9]{64}$/.test(provided) &&
      timingSafeEqual(Buffer.from(expected), Buffer.from(provided))
    );
  }

  /** Revokes the session identified by either token. Revocation keeps the row so replay detection still works. */
  async logout(accessToken?: string, refreshToken?: string) {
    if (!accessToken && !refreshToken) return;
    await this.database.pool.query(
      `UPDATE sessions SET revoked_at = COALESCE(revoked_at, now())
       WHERE ($1::text IS NOT NULL AND token_hash = $1)
          OR ($2::text IS NOT NULL AND id IN (
            SELECT session_id FROM session_refresh_tokens WHERE token_hash = $2
          ))`,
      [accessToken ? digest(accessToken) : null, refreshToken ? digest(refreshToken) : null],
    );
  }

  /** Active sessions for a user, newest activity first, with the current one flagged. */
  async listSessions(ownerId: string, currentSessionId: string) {
    z.string().uuid().parse(ownerId);
    z.string().uuid().parse(currentSessionId);
    const result = await this.database.pool.query<{
      id: string;
      created_at: Date | null;
      last_used_at: Date | null;
      device_label: string | null;
    }>(
      `SELECT id, created_at, last_used_at, device_label FROM sessions
       WHERE owner_id = $1 AND revoked_at IS NULL AND expires_at > now()
       ORDER BY last_used_at DESC NULLS LAST, created_at DESC NULLS LAST, id`,
      [ownerId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at?.toISOString() ?? null,
      lastUsedAt: row.last_used_at?.toISOString() ?? null,
      deviceLabel: row.device_label ?? 'Unknown device',
      current: row.id === currentSessionId,
    }));
  }

  /** Revokes one of the user's sessions. False if it does not exist or belongs to someone else. */
  async revokeSession(ownerId: string, sessionId: string) {
    z.string().uuid().parse(ownerId);
    z.string().uuid().parse(sessionId);
    const result = await this.database.pool.query(
      `UPDATE sessions SET revoked_at = COALESCE(revoked_at, now())
       WHERE owner_id = $1 AND id = $2`,
      [ownerId, sessionId],
    );
    return result.rowCount === 1;
  }

  /** Revokes every session except the one for `token`. The current session is verified under a user row lock first, so a stale token cannot revoke others. */
  async revokeOtherSessions(ownerId: string, token: string) {
    z.string().uuid().parse(ownerId);
    if (!/^[a-f0-9]{64}$/.test(token)) return false;
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [ownerId]);
      const current = await client.query<{ id: string }>(
        `SELECT id FROM sessions WHERE owner_id = $1 AND token_hash = $2
         AND access_expires_at > now() AND expires_at > now() AND revoked_at IS NULL FOR UPDATE`,
        [ownerId, digest(token)],
      );
      if (!current.rowCount) {
        await rollback(client);
        return false;
      }
      await client.query(
        `UPDATE sessions SET revoked_at = COALESCE(revoked_at, now())
         WHERE owner_id = $1 AND id <> $2`,
        [ownerId, current.rows[0]!.id],
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }
}
