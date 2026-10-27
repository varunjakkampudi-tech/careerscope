import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { Auth, Database, configuration } from '@careerscope/core';

async function main() {
  if (!process.stdin.isTTY) throw new Error('Interactive terminal required');
  const env = configuration();
  const database = new Database(env.DATABASE_URL);
  const reader = createInterface({
    input: process.stdin,
    terminal: true,
    output: new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    }),
  });
  try {
    const existing = await database.pool.query('SELECT id FROM users LIMIT 1');
    if (existing.rowCount) throw new Error('Owner already configured');
    process.stdout.write('Owner email (input hidden): ');
    const email = await reader.question('');
    process.stdout.write('\nPassword (12+ characters; input hidden): ');
    const password = await reader.question('');
    process.stdout.write('\nConfirm password (input hidden): ');
    const confirmation = await reader.question('');
    process.stdout.write('\n');
    if (password !== confirmation) throw new Error('Passwords do not match');
    await new Auth(database).createOwner(email, password);
    process.stdout.write(`Owner created. Sign in at ${env.APP_ORIGIN}\n`);
  } finally {
    reader.close();
    await database.close();
  }
}

main().catch(() => {
  process.stderr.write(
    'Owner setup failed or is unavailable. Existing accounts were not changed.\n',
  );
  process.exitCode = 1;
});
