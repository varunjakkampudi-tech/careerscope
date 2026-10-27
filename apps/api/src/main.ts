/**
 * API process entry point: loads configuration, connects Postgres and Redis, builds the app from
 * `app.ts`, listens on loopback and shuts down cleanly on SIGINT or SIGTERM.
 */

import {
  Database,
  configuration,
  configuredFileResumeStorage,
  ResendEmailOtpProvider,
  logger,
  rateLimiter,
  shutdownSignal,
  testAccessConfiguration,
} from '@careerscope/core';
import { createApp } from './app.js';

const env = configuration();
const emailOtp =
  env.EMAIL_OTP_ENABLED === 'true'
    ? {
        secret: Buffer.from(env.EMAIL_OTP_HMAC_SECRET!, 'utf8'),
        provider: new ResendEmailOtpProvider(env.RESEND_API_KEY!, env.RESEND_FROM_EMAIL),
      }
    : undefined;
const database = new Database(env.DATABASE_URL);
const limiter = await rateLimiter(env.REDIS_URL);
const resumeStorage = await configuredFileResumeStorage();
const app = await createApp(database, env.APP_ORIGIN, limiter.consume, {
  registrationEnabled: env.REGISTRATION_ENABLED === 'true',
  registrationPolicy:
    env.LEGAL_TERMS_VERSION &&
    env.LEGAL_TERMS_URL &&
    env.LEGAL_PRIVACY_VERSION &&
    env.LEGAL_PRIVACY_URL &&
    env.LEGAL_MARKETING_VERSION
      ? {
          termsVersion: env.LEGAL_TERMS_VERSION,
          termsUrl: env.LEGAL_TERMS_URL,
          privacyVersion: env.LEGAL_PRIVACY_VERSION,
          privacyUrl: env.LEGAL_PRIVACY_URL,
          marketingVersion: env.LEGAL_MARKETING_VERSION,
        }
      : undefined,
  testAccess: testAccessConfiguration(process.env, env.APP_ORIGIN),
  emailOtp,
  readiness: async () => {
    await limiter.client.ping();
  },
  resumeStorage: resumeStorage
    ? {
        bucket: resumeStorage.bucket,
        initialize: resumeStorage.initialize.bind(resumeStorage),
        put: resumeStorage.put.bind(resumeStorage),
        get: resumeStorage.get.bind(resumeStorage),
        recoverVersion: resumeStorage.recoverVersion.bind(resumeStorage),
        delete: resumeStorage.delete.bind(resumeStorage),
      }
    : undefined,
});
// Registered after the app is built but before listening, so a signal during startup still triggers cleanup.
const shutdown = shutdownSignal();
try {
  // This process is the only object writer, so nothing it owns is in flight yet.
  if (resumeStorage) {
    const reclaimed = await resumeStorage.reclaimTemporariesAtStartup(shutdown.signal);
    if (reclaimed.removed)
      logger.warn(reclaimed, 'Reclaimed resume temporaries from a dead writer');
  }
  await app.listen({ host: '127.0.0.1', port: 5390 });
  // Ties a running process to the source it was built from. Deliberately not on
  // /api/health, which is unauthenticated.
  logger.info(
    { port: 5390, revision: process.env.CAREERSCOPE_REVISION ?? 'unknown' },
    'API listening',
  );
  if (!shutdown.signal.aborted)
    await new Promise<void>((resolve) =>
      shutdown.signal.addEventListener('abort', () => resolve(), { once: true }),
    );
} finally {
  await app.close();
  await limiter.close();
  await database.close();
  resumeStorage?.close();
  shutdown.close();
}
