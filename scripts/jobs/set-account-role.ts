/**
 * Sets an account's role to `admin` or `candidate`. An admin role is accepted only for an account whose
 * authenticator is confirmed, and the database enforces that. Run it on the server, with DATABASE_URL set:
 *
 *   node --env-file=.env --import tsx scripts/jobs/set-account-role.ts <email> <admin|candidate>
 */

import { Database } from '../../packages/core/src/database.js';
import { setAccountRole, type AccountRole } from '../../packages/core/src/admin-second-factor.js';
import { installProcessFailureHandlers, logFailure } from '../../packages/core/src/failure.js';

installProcessFailureHandlers();

const [suppliedEmail, suppliedRole] = process.argv.slice(2);
const roles: readonly AccountRole[] = ['candidate', 'admin'];

if (!suppliedEmail || !suppliedRole || !roles.includes(suppliedRole as AccountRole)) {
  process.stderr.write('Usage: set-account-role.ts <email> <admin|candidate>\n');
  process.exit(2);
}

let database: Database | undefined;
try {
  database = new Database(process.env.DATABASE_URL!);
  const updated = await setAccountRole(
    database,
    suppliedEmail.trim().toLowerCase(),
    suppliedRole as AccountRole,
  );
  if (!updated) {
    process.stderr.write('No account has that address.\n');
    process.exitCode = 1;
  } else {
    process.stdout.write(`Role set to ${suppliedRole}.\n`);
  }
} catch (error) {
  // A refused admin role is the database check, so the operator is told why rather than a stack trace.
  if ((error as { code?: string }).code === '23514') {
    process.stderr.write(
      'Refused: the account must confirm an authenticator app before it can be an admin.\n',
    );
  } else {
    logFailure(error, {}, 'Role change failed');
  }
  process.exitCode = 1;
} finally {
  await database?.close();
}
