import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { Db } from '../index.js';
import { ApiProblem } from '../../errors.js';

const SCRYPT_OPTIONS = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
function deriveKey(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, SCRYPT_OPTIONS, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}
const ISSUER = 'job-radar';
const AUDIENCE = 'job-radar-web';
export const SESSION_SECONDS = 60 * 60;

export class AuthRepo {
  private readonly key: Uint8Array;

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    db.run('INSERT OR IGNORE INTO auth_signing_key (id, secret) VALUES (1, :secret)', {
      secret: randomBytes(32).toString('base64url'),
    });
    this.key = Buffer.from(
      String(db.get('SELECT secret FROM auth_signing_key WHERE id = 1')!['secret']),
      'base64url',
    );
  }

  configured(): boolean {
    return !!this.db.get('SELECT id FROM auth_owner WHERE id = 1');
  }

  resetForLocalSetup(): void {
    this.db.tx(() => {
      this.db.run('DELETE FROM auth_sessions');
      this.db.run('DELETE FROM auth_owner WHERE id = 1');
    });
  }

  async setup(email: string, password: string): Promise<void> {
    if (this.configured()) throw ApiProblem.conflict('An owner account already exists.');
    const salt = randomBytes(16).toString('hex');
    const hash = (await deriveKey(password, salt)).toString('hex');
    this.db.tx(() => {
      if (this.configured()) throw ApiProblem.conflict('An owner account already exists.');
      this.db.run('INSERT INTO auth_owner (id, email, password_hash) VALUES (1, :email, :hash)', {
        email: email.toLowerCase().trim(),
        hash: `${salt}:${hash}`,
      });
    });
  }

  async login(email: string, password: string): Promise<string> {
    const owner = this.db.get('SELECT email, password_hash FROM auth_owner WHERE id = 1');
    const [salt, expected] = owner
      ? String(owner['password_hash']).split(':')
      : ['0'.repeat(32), '0'.repeat(128)];
    const actual = await deriveKey(password, salt!);
    const correct = timingSafeEqual(actual, Buffer.from(expected!, 'hex'));
    if (!correct || !owner || String(owner['email']) !== email.trim().toLowerCase()) {
      throw ApiProblem.unauthorized('Invalid email or password.');
    }
    const issuedAt = Math.floor(this.now() / 1000);
    const id = randomUUID();
    this.db.run('DELETE FROM auth_sessions WHERE expires_at <= :at', { at: issuedAt });
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject('owner')
      .setJti(id)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + SESSION_SECONDS)
      .sign(this.key);
    this.db.run('INSERT INTO auth_sessions (id, expires_at) VALUES (:id, :expires)', {
      id,
      expires: issuedAt + SESSION_SECONDS,
    });
    return token;
  }

  async verify(token: string): Promise<{ id: string; email: string }> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ['HS256'],
        issuer: ISSUER,
        audience: AUDIENCE,
        currentDate: new Date(this.now()),
        requiredClaims: ['exp', 'iat', 'jti', 'sub'],
      });
      if (payload.sub !== 'owner' || !payload.jti) throw new Error('Invalid subject.');
      const session = this.db.get(
        'SELECT id FROM auth_sessions WHERE id = :id AND expires_at > :at',
        {
          id: payload.jti,
          at: Math.floor(this.now() / 1000),
        },
      );
      const owner = this.db.get('SELECT email FROM auth_owner WHERE id = 1');
      if (!session || !owner) throw new Error('Session revoked.');
      return { id: payload.jti, email: String(owner['email']) };
    } catch {
      throw ApiProblem.unauthorized('Your session has expired. Please sign in again.');
    }
  }

  revoke(id: string): void {
    this.db.run('DELETE FROM auth_sessions WHERE id = :id', { id });
  }
}
