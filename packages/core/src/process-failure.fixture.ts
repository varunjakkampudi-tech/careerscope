/** Child-process fixture for process-failure.test.ts: crashes on a malformed DATABASE_URL like a real entry point. */

import { configuration } from './runtime.js';
import { installProcessFailureHandlers } from './failure.js';

installProcessFailureHandlers();
if (process.argv[2] === 'rejection') {
  void Promise.reject(new Error(['postgres://user', ':S3cretPass@[bad host'].join('')));
} else {
  configuration();
}
