import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { z } from 'zod';
import type { Database } from './database.js';

export const sessionCookie = 'careerscope_v2_session';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const passwordHash = (password: string) =>
  hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 });

export class Auth {
  private readonly dummyHash = passwordHash(randomBytes(32).toString('hex'));

  constructor(private readonly database: Database) {}

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
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async login(email: string, password: string, previous?: string) {
    const result = await this.database.pool.query<{ id: string; password_hash: string }>(
      'SELECT id, password_hash FROM users WHERE email = $1',
      [email.toLowerCase().trim()],
    );
    const user = result.rows[0];
    const valid = await verify(user?.password_hash ?? (await this.dummyHash), password);
    if (!user || !valid) return null;
    const token = randomBytes(32).toString('hex');
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query<{ password_hash: string }>(
        'SELECT password_hash FROM users WHERE id = $1 FOR UPDATE',
        [user.id],
      );
      if (current.rows[0]?.password_hash !== user.password_hash) {
        await client.query('ROLLBACK');
        return null;
      }
      if (previous)
        await client.query('DELETE FROM sessions WHERE token_hash = $1', [digest(previous)]);
      await client.query(
        `INSERT INTO sessions (token_hash, owner_id, expires_at)
        VALUES ($1, $2, now() + interval '8 hours')`,
        [digest(token), user.id],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return token;
  }

  async session(token?: string) {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const result = await this.database.pool.query<{ owner_id: string }>(
      'SELECT owner_id FROM sessions WHERE token_hash = $1 AND expires_at > now()',
      [digest(token)],
    );
    const session = result.rows[0];
    return session ? { ownerId: session.owner_id, csrf: digest(`csrf:${token}`) } : null;
  }

  validCsrf(expected: string, provided: unknown) {
    return (
      typeof provided === 'string' &&
      /^[a-f0-9]{64}$/.test(provided) &&
      timingSafeEqual(Buffer.from(expected), Buffer.from(provided))
    );
  }

  async logout(token: string) {
    await this.database.pool.query('DELETE FROM sessions WHERE token_hash = $1', [digest(token)]);
  }

  async revokeOtherSessions(ownerId: string, token: string) {
    z.string().uuid().parse(ownerId);
    if (!/^[a-f0-9]{64}$/.test(token)) return false;
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [ownerId]);
      const current = await client.query(
        'SELECT token_hash FROM sessions WHERE owner_id = $1 AND token_hash = $2 AND expires_at > now() FOR UPDATE',
        [ownerId, digest(token)],
      );
      if (!current.rowCount) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query('DELETE FROM sessions WHERE owner_id = $1 AND token_hash <> $2', [
        ownerId,
        digest(token),
      ]);
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async changePassword(ownerId: string, currentPassword: string, newPassword: string) {
    z.string().uuid().parse(ownerId);
    z.string().min(12).max(256).parse(currentPassword);
    z.string().min(12).max(256).parse(newPassword);
    if (currentPassword === newPassword) return false;
    const result = await this.database.pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [ownerId],
    );
    const user = result.rows[0];
    const valid = await verify(user?.password_hash ?? (await this.dummyHash), currentPassword);
    if (!user || !valid) return false;
    const replacement = await passwordHash(newPassword);
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query(
        'UPDATE users SET password_hash = $1 WHERE id = $2 AND password_hash = $3 RETURNING id',
        [replacement, ownerId, user.password_hash],
      );
      if (!updated.rowCount) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query('DELETE FROM sessions WHERE owner_id = $1', [ownerId]);
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
