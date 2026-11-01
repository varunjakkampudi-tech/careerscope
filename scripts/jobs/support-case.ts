/**
 * Opens or closes a support case for an account whose mailbox is inaccessible (V12-4.1-014). Run it on the
 * server, with DATABASE_URL set:
 *
 *   node --env-file=.env --import tsx scripts/jobs/support-case.ts open <email> "<reason, at least 10 characters>"
 *   node --env-file=.env --import tsx scripts/jobs/support-case.ts close <case-id>
 *
 * Every open is printed with its id and expiry, so the reason and the operator are recorded in the table.
 */

import { userInfo } from 'node:os';
import { Database } from '../../packages/core/src/database.js';
import { closeSupportCase, openSupportCase } from '../../packages/core/src/support-cases.js';
import { installProcessFailureHandlers, logFailure } from '../../packages/core/src/failure.js';

installProcessFailureHandlers();

const [command, first, second] = process.argv.slice(2);
function usage(): never {
  process.stderr.write('Usage: support-case.ts open <email> "<reason>" | close <case-id>\n');
  process.exit(2);
}

let database: Database | undefined;
try {
  if (command === 'open') {
    if (!first || !second || second.trim().length < 10 || second.length > 500) usage();
    const email = first;
    const reason = second;
    database = new Database(process.env.DATABASE_URL!);
    const operator = process.env.CAREERSCOPE_OPERATOR ?? userInfo().username;
    const opened = await openSupportCase(database, email.trim().toLowerCase(), reason, operator);
    if (!opened) {
      process.stderr.write('No account has that address.\n');
      process.exitCode = 1;
    } else {
      process.stdout.write(
        `Support case ${opened.caseId} opened by ${operator}. It expires ${opened.expiresAt.toISOString()}.\n`,
      );
    }
  } else if (command === 'close') {
    const caseId = first;
    if (!caseId) usage();
    database = new Database(process.env.DATABASE_URL!);
    const closed = await closeSupportCase(database, caseId);
    process.stdout.write(closed ? 'Support case closed.\n' : 'No open case has that id.\n');
    if (!closed) process.exitCode = 1;
  } else {
    usage();
  }
} catch (error) {
  logFailure(error, {}, 'Support case command failed');
  process.exitCode = 1;
} finally {
  await database?.close();
}
