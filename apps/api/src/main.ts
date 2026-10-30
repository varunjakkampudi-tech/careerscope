/**
 * API process entry point: loads configuration, connects Postgres and Redis, builds the app from
 * `app.ts`, listens on loopback and shuts down cleanly on SIGINT or SIGTERM.
 */

import {
  Database,
  configuration,
  configuredFileResumeStorage,
  ResendEmailOtpProvider,
  installProcessFailureHandlers,
  logFailure,
  logger,
  rateLimiter,
  shutdownSignal,
  testAccessConfiguration,
} from '@careerscope/core';
import { API_PORT } from '@careerscope/shared';
import { createApp } from './app.js';

installProcessFailureHandlers();

let database: Database | undefined;
let limiter: Awaited<ReturnType<typeof rateLimiter>> | undefined;
let resumeStorage: Awaited<ReturnType<typeof configuredFileResumeStorage>>;
let cleaned = false;

try {
  const env = configuration();
  const emailOtp =
    env.EMAIL_OTP_ENABLED === 'true'
      ? {
          secret: Buffer.from(env.EMAIL_OTP_HMAC_SECRET!, 'utf8'),
          provider: new ResendEmailOtpProvider(env.RESEND_API_KEY!, env.RESEND_FROM_EMAIL),
        }
      : undefined;
  database = new Database(env.DATABASE_URL);
  const openLimiter = await rateLimiter(env.REDIS_URL);
  limiter = openLimiter;
  resumeStorage = await configuredFileResumeStorage();
  const app = await createApp(database, env.APP_ORIGIN, openLimiter.consume, {
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
      await openLimiter.client.ping();
    },
    resumeStorage: resumeStorage
      ? {
          bucket: resumeStorage.bucket,
          initialize: resumeStorage.initialize.bind(resumeStorage),
          put: resumeStorage.put.bind(resumeStorage),
          get: resumeStorage.get.bind(resumeStorage),
          recoverVersion: resumeStorage.recoverVersion.bind(resumeStorage),
          cancelUpload: resumeStorage.cancelUpload.bind(resumeStorage),
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
    await app.listen({ host: '127.0.0.1', port: API_PORT });
    // Ties a running process to the source it was built from. Deliberately not on
    // /api/health, which is unauthenticated.
    logger.info(
      { port: API_PORT, revision: process.env.CAREERSCOPE_REVISION ?? 'unknown' },
      'API listening',
    );
    if (!shutdown.signal.aborted)
      await new Promise<void>((resolve) =>
        shutdown.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
  } finally {
    cleaned = true;
    await app.close();
    await openLimiter.close();
    await database.close();
    resumeStorage?.close();
    shutdown.close();
  }
} catch (error) {
  // Bounds cleanup: a hung close must not keep the process alive.
  setTimeout(() => process.exit(1), 5000).unref();
  logFailure(error, {}, 'Startup failed');
  // An open Redis client or pool would keep the event loop alive, so release them and exit explicitly.
  if (!cleaned) {
    await limiter?.close().catch(() => {});
    await database?.close().catch(() => {});
    try {
      resumeStorage?.close();
    } catch {
      // Exiting regardless.
    }
  }
  process.exit(1);
}
