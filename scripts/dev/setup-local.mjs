/**
 * Creates the private local `.env` for development: generated passwords for
 * Postgres and Redis, the email HMAC secret, and loopback service URLs that
 * match infra/docker/compose.canonical.yml. It never overwrites an existing file.
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import process from 'node:process';

const databasePassword = randomBytes(24).toString('hex');
const redisPassword = randomBytes(24).toString('hex');
const hmacSecret = randomBytes(32).toString('hex');

writeFileSync(
  new URL('../../.env', import.meta.url),
  [
    '# Local development configuration. Keep this file private; it is git-ignored.',
    `CAREERSCOPE_DATABASE_PASSWORD=${databasePassword}`,
    `REDIS_PASSWORD=${redisPassword}`,
    `DATABASE_URL=postgres://careerscope:${databasePassword}@127.0.0.1:55433/careerscope`,
    `REDIS_URL=redis://:${redisPassword}@127.0.0.1:56479`,
    `QUEUE_REDIS_URL=redis://:${redisPassword}@127.0.0.1:56480`,
    `SEARCH_QUEUE_REDIS_URL=redis://:${redisPassword}@127.0.0.1:56480`,
    'SEARCH_QUEUE_TRANSPORT=redis',
    'NODE_ENV=development',
    'DEPLOYMENT_ENVIRONMENT=development',
    'APP_ORIGIN=http://localhost:5280',
    'REGISTRATION_ENABLED=false',
    'EMAIL_OTP_ENABLED=false',
    `EMAIL_OTP_HMAC_SECRET=${hmacSecret}`,
    'RESEND_API_KEY=',
    'RESEND_FROM_EMAIL=CareerScope <noreply@careerscope.tech>',
    'LEGAL_TERMS_VERSION=2026-10-01',
    'LEGAL_TERMS_URL=http://localhost:5280/legal/terms',
    'LEGAL_PRIVACY_VERSION=2026-10-01',
    'LEGAL_PRIVACY_URL=http://localhost:5280/legal/privacy',
    'LEGAL_MARKETING_VERSION=2026-10-01',
    'FILES_QUEUE_NAME=careerscope-files',
    'TEST_ACCESS_MODE=local',
    'CAREERSCOPE_REVISION=local-development',
    '',
  ].join('\n'),
  { flag: 'wx', mode: 0o600 },
);
process.stdout.write(
  'Created private local configuration. Existing files are never overwritten.\n',
);
