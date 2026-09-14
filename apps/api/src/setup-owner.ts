import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { parseEnv } from './env.js';

async function main(): Promise<void> {
  if (!process.stdin.isTTY) throw new Error('Run this command in your own interactive terminal.');
  const env = parseEnv();
  if (env.NODE_ENV !== 'development' || env.TRUST_PROXY || !env.LOGIN_ENABLED) {
    throw new Error('Owner setup requires the local development container with login enabled.');
  }
  const endpoint = `http://127.0.0.1:${env.PORT}/api/auth`;
  const status = await fetch(`${endpoint}/session`, { signal: AbortSignal.timeout(5000) });
  const session = (await status.json()) as { configured?: boolean; canSetup?: boolean };
  if (!status.ok || session.configured || !session.canSetup) {
    throw new Error('Owner setup is not available. Existing accounts were not changed.');
  }
  const silent = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const reader = createInterface({ input: process.stdin, output: silent, terminal: true });
  try {
    process.stdout.write('Owner email (input hidden): ');
    const email = await reader.question('');
    process.stdout.write('\nOwner password (12+ characters; input hidden): ');
    const password = await reader.question('');
    process.stdout.write('\nConfirm password (input hidden): ');
    const confirmation = await reader.question('');
    process.stdout.write('\n');
    if (password !== confirmation) throw new Error('Passwords do not match. No account created.');
    const response = await fetch(`${endpoint}/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: env.AUTH_ORIGIN },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status !== 201) {
      throw new Error('Setup was rejected. Check the email, password length and account state.');
    }
    process.stdout.write(`Owner created. Sign in at ${new URL('/login', env.AUTH_ORIGIN).href}\n`);
  } finally {
    reader.close();
  }
}

main().catch(() => {
  process.stderr.write('Owner setup failed or is unavailable. No credentials were printed.\n');
  process.exitCode = 1;
});
