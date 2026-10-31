import { mkdir } from 'node:fs/promises';
import process from 'node:process';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Database, configuredFileResumeStorage } from '@careerscope/core';
import { ensureResumeKey } from './resume-key.mjs';

await mkdir('/private/objects', { recursive: true, mode: 0o700 });
// Writes the key atomically and rejects an empty or truncated one with an operator message.
await ensureResumeKey('/private/encryption.key');
const storage = await configuredFileResumeStorage();
storage.close();
const database = new Database(process.env.DATABASE_URL);
try {
  await migrate(database.db, { migrationsFolder: '/app/migrations' });
  process.stdout.write('Private storage and migrations ready\n');
} finally {
  await database.close();
}
