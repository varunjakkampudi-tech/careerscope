import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Database } from '../packages/core/src/database.js';

const database = new Database(process.env.DATABASE_URL!);
try {
  await migrate(database.db, {
    migrationsFolder: new URL('../migrations', import.meta.url).pathname,
  });
  process.stdout.write('V2 database migrations applied.\n');
} finally {
  await database.close();
}
