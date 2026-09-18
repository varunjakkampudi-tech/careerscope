import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import process from 'node:process';

const password = randomBytes(32).toString('hex');
writeFileSync(
  new URL('../.env', import.meta.url),
  [
    `V2_DATABASE_PASSWORD=${password}`,
    `DATABASE_URL=postgresql://careerscope:${password}@127.0.0.1:55433/careerscope`,
    'REDIS_URL=redis://127.0.0.1:56479',
    'LOCAL_AWS_ENDPOINT=http://127.0.0.1:54566',
    'APP_ORIGIN=http://localhost:5280',
    '',
  ].join('\n'),
  { flag: 'wx', mode: 0o600 },
);
process.stdout.write(
  'Created private local configuration. Existing files are never overwritten.\n',
);
