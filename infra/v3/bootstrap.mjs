import { randomBytes } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import process from 'node:process';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Database, configuredFileResumeStorage } from '@careerscope/core';

await mkdir('/private/objects', { recursive: true, mode: 0o700 });
let handle;
try {
  handle = await open('/private/encryption.key', 'wx', 0o600);
  const key = randomBytes(32);
  try {
    await handle.writeFile(key.toString('hex'));
    await handle.sync();
  } finally {
    key.fill(0);
  }
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
} finally {
  await handle?.close();
}
const storage = await configuredFileResumeStorage();
storage.close();
const database = new Database(process.env.DATABASE_URL);
try {
  await migrate(database.db, { migrationsFolder: '/app/v2/migrations' });
  process.stdout.write('Private storage and migrations ready\n');
} finally {
  await database.close();
}
