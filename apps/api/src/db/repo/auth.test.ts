import { expect, it } from 'vitest';
import { createTestRepos } from './repo.fixtures.js';
import { AuthRepo, SESSION_SECONDS } from './auth.js';

it('recovers local setup without deleting application data and revokes old sessions', async () => {
  const fixture = createTestRepos();
  const auth = new AuthRepo(fixture.db);
  try {
    fixture.db.exec('CREATE TABLE recovery_test_data (value TEXT)');
    fixture.db.run("INSERT INTO recovery_test_data VALUES ('keep me')");
    await auth.setup('owner@example.com', 'old synthetic password');
    const token = await auth.login('owner@example.com', 'old synthetic password');
    auth.resetForLocalSetup();
    expect(auth.configured()).toBe(false);
    expect(fixture.db.get('SELECT value FROM recovery_test_data')?.['value']).toBe('keep me');
    await expect(auth.verify(token)).rejects.toThrow();
    await auth.setup('owner@example.com', 'new synthetic password');
    await expect(auth.verify(token)).rejects.toThrow();
    await expect(auth.login('owner@example.com', 'old synthetic password')).rejects.toThrow();
    const replacement = await auth.login('owner@example.com', 'new synthetic password');
    await expect(auth.verify(replacement)).resolves.toMatchObject({ email: 'owner@example.com' });
  } finally {
    fixture.cleanup();
  }
});

it('hashes credentials, signs expiring tokens and enforces revocation', async () => {
  const fixture = createTestRepos();
  let now = Date.now();
  const auth = new AuthRepo(fixture.db, () => now);
  try {
    expect(auth.configured()).toBe(false);
    await auth.setup('Owner@example.com', 'synthetic long test password');
    expect(JSON.stringify(fixture.db.get('SELECT * FROM auth_owner'))).not.toContain(
      'synthetic long test password',
    );
    await expect(auth.setup('other@example.com', 'another test password')).rejects.toThrow(
      /already exists/,
    );
    await expect(auth.login('owner@example.com', 'wrong')).rejects.toThrow(
      /Invalid email or password/,
    );
    await expect(auth.login('other@example.com', 'synthetic long test password')).rejects.toThrow(
      /Invalid email or password/,
    );
    const token = await auth.login('owner@example.com', 'synthetic long test password');
    const session = await auth.verify(token);
    expect(session.email).toBe('owner@example.com');
    await expect(auth.verify(`${token.slice(0, -8)}tampered`)).rejects.toThrow();
    auth.revoke(session.id);
    await expect(auth.verify(token)).rejects.toThrow();
    const expiring = await auth.login('owner@example.com', 'synthetic long test password');
    now += (SESSION_SECONDS + 1) * 1000;
    await expect(auth.verify(expiring)).rejects.toThrow();
  } finally {
    fixture.cleanup();
  }
});
