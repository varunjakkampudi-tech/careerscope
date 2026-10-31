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

// Registered before any resource is opened: a SIGINT or SIGTERM during any startup step must reach the
// cleanup below instead of taking the default handler, which would exit without closing anything.
const shutdown = shutdownSignal();
let database: Database | undefined;
let limiter: Awaited<ReturnType<typeof rateLimiter>> | undefined;
let resumeStorage: Awaited<ReturnType<typeof configuredFileResumeStorage>>;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let cleaned = false;
let stopReclaim: (() => void) | undefined;

/** True when `error` is the abort caused by the shutdown signal rather than a real failure. */
function isShutdownAbort(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted &&
    (error === signal.reason || (error instanceof Error && error.name === 'AbortError'))
  );
}

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
  try {
    limiter = await rateLimiter(env.REDIS_URL);
    shutdown.signal.throwIfAborted();
    const openLimiter = limiter;
    resumeStorage = await configuredFileResumeStorage();
    shutdown.signal.throwIfAborted();
    app = await createApp(database, env.APP_ORIGIN, openLimiter.consume, {
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
    shutdown.signal.throwIfAborted();
    // Reclaim removes only temporaries older than 10 minutes; a writer stalled past that bound retries once.
    // The API owns resume writes, so it also sweeps periodically; the timer is unreferenced and logs counts only.
    if (resumeStorage) {
      const reclaimed = await resumeStorage.reclaimTemporariesAtStartup(shutdown.signal);
      if (reclaimed.removed) logger.warn(reclaimed, 'Reclaimed stale resume temporaries');
      stopReclaim = resumeStorage.startReclaimSweep({
        onResult: (result) => {
          if (result.removed || result.markersRemoved)
            logger.info(
              { temporaries: result.removed, markers: result.markersRemoved },
              'Resume storage sweep reclaimed entries',
            );
        },
        onError: (error) => logFailure(error, {}, 'Resume storage sweep failed'),
      });
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
  } catch (error) {
    // A shutdown signal that interrupts startup is a clean stop, not a failure, even when the step it
    // interrupted then fails (for example a connection that gives up). Cleanup runs once in the finally
    // block and the process exits 0.
    if (!shutdown.signal.aborted) throw error;
    if (!isShutdownAbort(error, shutdown.signal))
      logFailure(error, {}, 'Startup step failed after shutdown was requested');
    logger.info('Shutdown requested during startup');
  } finally {
    stopReclaim?.();
    await app?.close();
    await limiter?.close();
    await database?.close();
    resumeStorage?.close();
    shutdown.close();
    cleaned = true;
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
