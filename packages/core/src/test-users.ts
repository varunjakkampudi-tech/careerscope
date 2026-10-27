/**
 * Fixed test accounts and the guard that decides whether test sign-in is allowed. Used by the API
 * auth routes; configuration is read from environment values passed in by the caller.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

/** Fixed accounts for local and staging test access; ids are stable so fixtures can refer to them. */
export const testUsers = [
  {
    id: 'f3040401-c357-4d17-8000-000000000001',
    email: 'varun@careerscope.tech',
    role: 'candidate',
  },
  { id: 'f3040401-c357-4d17-8000-000000000002', email: 'admin@careerscope.tech', role: 'admin' },
] as const;

/** Resolved test-access policy. `proxySecret` is present only in `proxy` mode. */
export type TestAccess = { mode: 'disabled' | 'local' | 'proxy'; proxySecret?: string };

/**
 * Resolves and validates test-access mode from the environment. Fails closed: production never
 * allows it, `local` needs a development loopback origin, and `proxy` needs staging, HTTPS and a
 * 32-byte hex secret.
 */
export function testAccessConfiguration(source: NodeJS.ProcessEnv, origin: string): TestAccess {
  const environment =
    source.DEPLOYMENT_ENVIRONMENT ??
    (source.NODE_ENV === 'production' ? 'production' : 'development');
  if (!['development', 'staging', 'production'].includes(environment))
    throw new Error('Invalid DEPLOYMENT_ENVIRONMENT');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname);
  const mode =
    source.TEST_ACCESS_MODE ??
    (environment === 'development' && loopback && source.NODE_ENV !== 'production'
      ? 'local'
      : 'disabled');
  if (!['disabled', 'local', 'proxy'].includes(mode)) throw new Error('Invalid TEST_ACCESS_MODE');
  if (environment === 'production' && mode !== 'disabled')
    throw new Error('Test access is prohibited in production');
  if (
    mode === 'local' &&
    (environment !== 'development' || !loopback || source.NODE_ENV === 'production')
  )
    throw new Error('Local test access requires a development loopback origin');
  if (mode === 'proxy') {
    if (environment !== 'staging')
      throw new Error('Hosted test access requires an explicit staging environment');
    if (new URL(origin).protocol !== 'https:') throw new Error('Hosted test access requires HTTPS');
    if (!source.TEST_PROXY_SECRET || !/^[a-f0-9]{64}$/.test(source.TEST_PROXY_SECRET))
      throw new Error('Hosted test access requires a private 32-byte proxy secret');
  }
  return {
    mode: mode as TestAccess['mode'],
    ...(mode === 'proxy' ? { proxySecret: source.TEST_PROXY_SECRET } : {}),
  };
}

/**
 * True only when the peer address is loopback and the mode allows it. In `proxy` mode the header
 * must match the secret; both sides are hashed first so the constant-time comparison sees equal lengths.
 */
export function testAccessAllowed(access: TestAccess, address: string, header: unknown): boolean {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address) || access.mode === 'disabled')
    return false;
  if (access.mode === 'local') return true;
  if (typeof header !== 'string' || !access.proxySecret || header.length !== 64) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(header), digest(access.proxySecret));
}
