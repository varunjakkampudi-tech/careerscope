import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Database } from '../../packages/core/src/database.js';
import { logFailure } from '../../packages/core/src/failure.js';

const database = new Database(process.env.DATABASE_URL!);
try {
  await migrate(database.db, {
    migrationsFolder: fileURLToPath(new URL('../../migrations', import.meta.url)),
  });
  process.stdout.write('CareerScope database migrations applied.\n');
} catch (error) {
  logFailure(error, {}, 'Migration failed');
  process.exitCode = 1;
} finally {
  await database.close();
}
