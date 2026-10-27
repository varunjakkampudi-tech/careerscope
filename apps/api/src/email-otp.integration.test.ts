import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import {
  Database,
  EmailOtpProviderError,
  createEmailOtp,
  hashOtpEmail,
  rateLimiter,
  type EmailOtpDeliveryMessage,
} from '@careerscope/core';
import { createApp } from './app.js';

test(
  'email OTP authenticates existing owners, prevents enumeration/account creation and shares cooldown across API instances',
  { timeout: 60_000 },
  async () => {
    const configuredDatabase = process.env.DATABASE_URL;
    const configuredRedis = process.env.REDIS_URL;
    assert.ok(configuredDatabase, 'integration test requires an isolated DATABASE_URL');
    assert.ok(configuredRedis, 'integration test requires an isolated REDIS_URL');
    const databaseUrl = new URL(configuredDatabase);
    assert.ok(['127.0.0.1', 'localhost'].includes(databaseUrl.hostname));

    const admin = new Database(configuredDatabase);
    const name = `test_${randomUUID().replaceAll('-', '')}`;
    await admin.pool.query(`CREATE DATABASE "${name}"`);
    databaseUrl.pathname = `/${name}`;
    const database = new Database(databaseUrl.href);
    const redisPrefix = `test:email-otp:${randomUUID()}:`;
    const limiterOne = await rateLimiter(configuredRedis, redisPrefix);
    const limiterTwo = await rateLimiter(configuredRedis, redisPrefix);
    const secret = Buffer.alloc(32, 23);
    const origin = 'https://careerscope.test';
    const delivered: EmailOtpDeliveryMessage[] = [];
    const failedRecipients = new Set<string>();
    const candidateId = randomUUID();
    const failedDeliveryId = randomUUID();
    const concurrentId = randomUUID();
    const sessionFailureId = randomUUID();
    const provider = {
      async send(message: EmailOtpDeliveryMessage) {
        delivered.push(message);
        if (failedRecipients.has(message.email)) throw new EmailOtpProviderError(true);
      },
    };
    let appOne: FastifyInstance | undefined;
    let appTwo: FastifyInstance | undefined;

    try {
      await migrate(database.db, {
        migrationsFolder: fileURLToPath(new URL('../../../migrations', import.meta.url)),
      });
      await database.pool.query(
        `INSERT INTO users (id, email, password_hash) VALUES
         ($1, $2, $3), ($4, $5, $3), ($6, $7, $3), ($8, $9, $3)`,
        [
          candidateId,
          'candidate@example.test',
          'synthetic unused password hash',
          failedDeliveryId,
          'failed-delivery@example.test',
          concurrentId,
          'concurrent@example.test',
          sessionFailureId,
          'session-failure@example.test',
        ],
      );
      appOne = await createApp(database, origin, limiterOne.consume, {
        // Match the executable production composition: a disabled selector is
        // explicit and must not disable the separately configured OTP signup.
        testAccess: { mode: 'disabled' },
        emailOtp: { secret, provider },
        registrationEnabled: true,
        registrationPolicy: {
          termsVersion: 'terms-test-1',
          termsUrl: 'https://careerscope.test/terms',
          privacyVersion: 'privacy-test-1',
          privacyUrl: 'https://careerscope.test/privacy',
          marketingVersion: 'marketing-test-1',
        },
      });
      appTwo = await createApp(database, origin, limiterTwo.consume, {
        testAccess: { mode: 'disabled' },
        emailOtp: { secret, provider },
        registrationEnabled: true,
        registrationPolicy: {
          termsVersion: 'terms-test-1',
          termsUrl: 'https://careerscope.test/terms',
          privacyVersion: 'privacy-test-1',
          privacyUrl: 'https://careerscope.test/privacy',
          marketingVersion: 'marketing-test-1',
        },
      });

      const productionSession = (await appOne.inject('/api/session')).json();
      assert.equal(productionSession.registrationEnabled, true);
      assert.equal(productionSession.testUsersEnabled, false);
      assert.deepEqual(productionSession.testAccounts, []);

      const requestCode = (
        app: FastifyInstance,
        email: string,
        extra: Record<string, unknown> = {},
        remoteAddress?: string,
        forwardedFor?: string,
      ) =>
        app.inject({
          method: 'POST',
          url: '/api/otp/request',
          headers: { origin, ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}) },
          payload: { email, ...extra },
          remoteAddress,
        });
      const verifyCode = (
        app: FastifyInstance,
        email: string,
        code: string,
        extra: Record<string, unknown> = {},
        remoteAddress?: string,
      ) =>
        app.inject({
          method: 'POST',
          url: '/api/otp/verify',
          headers: { origin },
          payload: { email, code, ...extra },
          remoteAddress,
        });

      const legacyPasswordLogin = await appOne.inject({
        method: 'POST',
        url: '/api/login',
        headers: { origin },
        payload: { email: 'candidate@example.test', password: 'unused' },
      });
      assert.equal(legacyPasswordLogin.statusCode, 404);

      const known = await requestCode(appOne!, 'Candidate@Example.Test');
      assert.equal(known.statusCode, 202);
      const acceptedBody = known.json();
      assert.deepEqual(acceptedBody, {
        message: 'If the request can be completed, check your inbox for a verification code.',
        expiresInSeconds: 300,
        resendAfterSeconds: 60,
      });
      assert.equal(delivered.length, 1);
      assert.equal(delivered[0]?.email, 'candidate@example.test');

      const unknown = await requestCode(appOne!, 'unknown-user@example.test');
      assert.equal(unknown.statusCode, 202);
      assert.deepEqual(unknown.json(), acceptedBody);
      assert.equal(delivered.length, 2, 'known and unknown addresses take the same delivery path');
      assert.equal(
        (
          await database.pool.query('SELECT id FROM users WHERE email = $1', [
            'unknown-user@example.test',
          ])
        ).rowCount,
        0,
        'OTP requests must never create accounts',
      );
      assert.equal(
        (await verifyCode(appOne!, 'unknown-user@example.test', delivered[1]!.code)).statusCode,
        401,
        'valid OTP must not create a session for an unknown account',
      );

      const fromSecondInstance = await requestCode(appTwo!, 'candidate@example.test');
      assert.equal(fromSecondInstance.statusCode, 202);
      assert.deepEqual(fromSecondInstance.json(), acceptedBody);
      assert.equal(
        delivered.length,
        2,
        'shared Redis cooldown must suppress a second instance send',
      );

      // Regression coverage for the existing IP-keyed request limit. Use an
      // untrusted peer address and rotate X-Forwarded-For to verify that only a
      // trusted proxy may supply the effective client address. This test does
      // not claim the pending A1.2/CR-07 LB8 acceptance contract is approved.
      const syntheticPeer = '198.51.100.23';
      const ipKey = `${redisPrefix}otp:request:ip:${createHash('sha256')
        .update(syntheticPeer)
        .digest('hex')}`;
      await limiterOne.client.del(ipKey);
      const deliveryCountBeforeIpBudget = delivered.length;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const response = await requestCode(
          attempt % 2 === 0 ? appOne! : appTwo!,
          `ip-budget-${attempt}@example.test`,
          {},
          syntheticPeer,
          `203.0.113.${attempt + 1}`,
        );
        assert.equal(response.statusCode, 202, `IP request ${attempt + 1} is within the budget`);
      }
      const overBudget = await requestCode(
        appOne!,
        'ip-budget-over@example.test',
        {},
        syntheticPeer,
        '203.0.113.250',
      );
      assert.equal(overBudget.statusCode, 429, 'the eleventh request from one peer is rejected');
      assert.equal(
        delivered.length,
        deliveryCountBeforeIpBudget + 10,
        'the over-budget request must not reach the delivery provider',
      );

      const challenge = delivered[0]!;
      const incorrect = challenge.code === '000000' ? '000001' : '000000';
      const wrong = await verifyCode(appOne!, challenge.email, incorrect);
      assert.equal(wrong.statusCode, 401);
      assert.equal(wrong.json().message, 'Invalid or expired verification code');

      const verified = await verifyCode(appOne!, challenge.email, challenge.code);
      assert.equal(verified.statusCode, 200);
      assert.deepEqual(verified.json(), { authenticated: true });
      const cookieHeaders = verified.headers['set-cookie'];
      const cookies = Array.isArray(cookieHeaders) ? cookieHeaders : [String(cookieHeaders)];
      assert.equal(cookies.length, 2);
      for (const value of cookies) {
        assert.match(value, /HttpOnly/i);
        assert.match(value, /Secure/i);
        assert.match(value, /SameSite=Strict/i);
      }
      const sessionCookie = cookies.find((value) => value.startsWith('careerscope_v2_session='))!;
      const refreshCookie = cookies.find((value) => value.startsWith('careerscope_v2_refresh='))!;
      assert.match(sessionCookie, /Path=\/api(?:;|$)/i);
      assert.match(refreshCookie, /Path=\/api\/session(?:;|$)/i);
      const sessionValue = sessionCookie.split(';', 1)[0]!;
      const refreshValue = refreshCookie.split(';', 1)[0]!;
      const cookieHeader = `${sessionValue}; ${refreshValue}`;
      const session = await appOne!.inject({
        method: 'GET',
        url: '/api/session',
        headers: { cookie: cookieHeader },
      });
      assert.equal(session.statusCode, 200);
      assert.equal(session.json().authenticated, true);
      assert.equal(session.json().email, challenge.email);
      assert.match(session.json().sessionId, /^[0-9a-f-]{36}$/i);
      const inventory = await appOne!.inject({
        method: 'GET',
        url: '/api/account/sessions',
        headers: { cookie: cookieHeader },
      });
      assert.equal(inventory.statusCode, 200);
      assert.equal(inventory.json().sessions.length, 1);
      assert.equal(inventory.json().sessions[0].current, true);
      assert.equal(inventory.json().sessions[0].deviceLabel, 'Unknown device');

      const rotated = await appOne!.inject({
        method: 'POST',
        url: '/api/session/refresh',
        headers: { origin, cookie: refreshValue },
        payload: {},
      });
      assert.equal(rotated.statusCode, 200);
      assert.match(rotated.json().csrf, /^[a-f0-9]{64}$/);
      const rotatedHeaders = rotated.headers['set-cookie'];
      const rotatedCookies = Array.isArray(rotatedHeaders)
        ? rotatedHeaders
        : [String(rotatedHeaders)];
      const rotatedAccess = rotatedCookies.find((value) =>
        value.startsWith('careerscope_v2_session='),
      )!;
      assert.ok(rotatedAccess);
      assert.notEqual(rotatedAccess.split(';', 1)[0], sessionValue);
      const rotatedAccessValue = rotatedAccess.split(';', 1)[0]!;
      assert.equal(
        (
          await database.pool.query<{ email_verified_at: Date | null }>(
            'SELECT email_verified_at FROM users WHERE email = $1',
            [challenge.email],
          )
        ).rows[0]?.email_verified_at instanceof Date,
        true,
      );
      const replay = await verifyCode(appOne!, challenge.email, challenge.code);
      assert.equal(replay.statusCode, 401, 'a consumed OTP must not establish another session');

      const concurrentRequest = await requestCode(appOne!, 'concurrent@example.test');
      assert.equal(concurrentRequest.statusCode, 202);
      const concurrentChallenge = delivered.at(-1)!;
      const concurrentVerifications = await Promise.all([
        verifyCode(appOne!, concurrentChallenge.email, concurrentChallenge.code),
        verifyCode(appTwo!, concurrentChallenge.email, concurrentChallenge.code),
      ]);
      assert.deepEqual(
        concurrentVerifications.map((response) => response.statusCode).toSorted(),
        [200, 401],
        'concurrent verification must establish at most one session',
      );
      assert.equal(
        (
          await database.pool.query('SELECT token_hash FROM sessions WHERE owner_id = $1', [
            concurrentId,
          ])
        ).rowCount,
        1,
      );
      const concurrentWinner = concurrentVerifications.find(
        (response) => response.statusCode === 200,
      )!;
      const concurrentCookies = concurrentWinner.headers['set-cookie'];
      const concurrentSetCookies = Array.isArray(concurrentCookies)
        ? concurrentCookies
        : [String(concurrentCookies)];
      const concurrentRefresh = concurrentSetCookies
        .find((value) => value.startsWith('careerscope_v2_refresh='))!
        .split(';', 1)[0]!;
      const racingRefreshes = await Promise.all([
        appOne!.inject({
          method: 'POST',
          url: '/api/session/refresh',
          headers: { origin, cookie: concurrentRefresh },
          payload: {},
        }),
        appTwo!.inject({
          method: 'POST',
          url: '/api/session/refresh',
          headers: { origin, cookie: concurrentRefresh },
          payload: {},
        }),
      ]);
      assert.deepEqual(
        racingRefreshes.map((response) => response.statusCode).toSorted(),
        [200, 401],
        'concurrent refresh must rotate once and detect the second use',
      );
      const racingWinner = racingRefreshes.find((response) => response.statusCode === 200)!;
      const racingWinnerCookies = racingWinner.headers['set-cookie'];
      const racingWinnerSetCookies = Array.isArray(racingWinnerCookies)
        ? racingWinnerCookies
        : [String(racingWinnerCookies)];
      const racingWinnerAccess = racingWinnerSetCookies
        .find((value) => value.startsWith('careerscope_v2_session='))!
        .split(';', 1)[0]!;
      assert.equal(
        (
          await appOne!.inject({
            url: '/api/session',
            headers: { cookie: racingWinnerAccess },
          })
        ).json().authenticated,
        false,
        'reuse racing a rotation revokes the resulting session family',
      );

      // OTP consumption and session establishment use separate transactions.
      // Prove a failure in the latter creates no partial session and remains
      // recoverable by requesting a fresh code after the normal resend cooldown.
      await database.pool.query(`
        CREATE FUNCTION reject_synthetic_session_insert() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.owner_id = '${sessionFailureId}'::uuid THEN
            RAISE EXCEPTION 'synthetic session persistence failure';
          END IF;
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER reject_synthetic_session_insert
          BEFORE INSERT ON sessions
          FOR EACH ROW EXECUTE FUNCTION reject_synthetic_session_insert();
      `);
      const failedSessionRequest = await requestCode(appOne!, 'session-failure@example.test');
      assert.equal(failedSessionRequest.statusCode, 202);
      const failedSessionChallenge = delivered.at(-1)!;
      const failedSessionVerification = await verifyCode(
        appOne!,
        failedSessionChallenge.email,
        failedSessionChallenge.code,
      );
      assert.equal(failedSessionVerification.statusCode, 503);
      assert.equal(failedSessionVerification.json().message, 'Sign-in is temporarily unavailable');
      assert.equal(
        (
          await database.pool.query('SELECT 1 FROM sessions WHERE owner_id = $1', [
            sessionFailureId,
          ])
        ).rowCount,
        0,
        'failed session persistence must not leave an authenticated session',
      );
      assert.equal(
        (
          await database.pool.query('SELECT 1 FROM email_otp_challenges WHERE email_hash = $1', [
            hashOtpEmail('session-failure@example.test', secret),
          ])
        ).rowCount,
        0,
        'a consumed OTP is not reusable after session persistence fails',
      );
      await database.pool.query(`
        DROP TRIGGER reject_synthetic_session_insert ON sessions;
        DROP FUNCTION reject_synthetic_session_insert();
      `);
      await limiterOne.client.del(
        `${redisPrefix}otp:request:email-cooldown:${hashOtpEmail('session-failure@example.test', secret)}`,
      );
      const recoveryRequest = await requestCode(appOne!, 'session-failure@example.test');
      assert.equal(recoveryRequest.statusCode, 202);
      assert.equal(delivered.at(-1)?.email, 'session-failure@example.test');
      const recovered = await verifyCode(
        appOne!,
        'session-failure@example.test',
        delivered.at(-1)!.code,
      );
      assert.equal(recovered.statusCode, 200);
      assert.equal(recovered.json().authenticated, true);
      assert.equal(
        (
          await database.pool.query('SELECT 1 FROM sessions WHERE owner_id = $1', [
            sessionFailureId,
          ])
        ).rowCount,
        1,
      );

      failedRecipients.add('failed-delivery@example.test');
      const failedSend = await requestCode(appOne!, 'failed-delivery@example.test');
      assert.equal(failedSend.statusCode, 503);
      assert.equal(failedSend.json().message, 'Sign-in is temporarily unavailable');
      const failedCode = delivered.at(-1)!;
      assert.equal(
        (await verifyCode(appOne!, failedCode.email, failedCode.code)).statusCode,
        401,
        'failed delivery must invalidate the associated challenge',
      );

      const signupEmail = 'new-candidate@example.test';
      const signupRequest = {
        intent: 'sign-up',
        termsAccepted: true,
        privacyAcknowledged: true,
        marketingOptIn: true,
        dateOfBirth: '1990-01-01',
      };
      const missingAcceptance = await requestCode(
        appOne!,
        signupEmail,
        { intent: 'sign-up', termsAccepted: false, privacyAcknowledged: true },
        '192.0.2.44',
      );
      assert.equal(missingAcceptance.statusCode, 400);
      const signinAcceptanceInjection = await requestCode(
        appOne!,
        signupEmail,
        { intent: 'sign-in', marketingOptIn: true },
        '192.0.2.48',
      );
      assert.equal(signinAcceptanceInjection.statusCode, 400);
      const missingBirthDate = await requestCode(
        appOne!,
        signupEmail,
        {
          intent: 'sign-up',
          termsAccepted: true,
          privacyAcknowledged: true,
          marketingOptIn: false,
        },
        '192.0.2.51',
      );
      assert.equal(missingBirthDate.statusCode, 400, 'signup requires a date for age screening');
      const signinBirthDateInjection = await requestCode(
        appOne!,
        signupEmail,
        { dateOfBirth: '1990-01-01' },
        '192.0.2.52',
      );
      assert.equal(signinBirthDateInjection.statusCode, 400, 'sign-in rejects signup-only data');
      const legacySignupEmail = 'legacy-signup-challenge@example.test';
      const legacySignupId = randomUUID();
      const legacySignupCode = createEmailOtp(legacySignupId, secret);
      await database.pool.query(
        `INSERT INTO email_otp_challenges
          (id, email_hash, digest, expires_at, intent, terms_version, privacy_version)
         VALUES ($1, $2, $3, $4, 'sign-up', 'terms-test-1', 'privacy-test-1')`,
        [
          legacySignupId,
          hashOtpEmail(legacySignupEmail, secret),
          legacySignupCode.digest,
          new Date(legacySignupCode.expiresAt),
        ],
      );
      const legacySignupVerify = await verifyCode(
        appOne!,
        legacySignupEmail,
        legacySignupCode.code,
        { intent: 'sign-up' },
        '192.0.2.53',
      );
      assert.equal(
        legacySignupVerify.statusCode,
        401,
        'legacy challenges without a screen fail closed',
      );
      assert.equal(
        (await database.pool.query('SELECT id FROM users WHERE email = $1', [legacySignupEmail]))
          .rowCount,
        0,
        'legacy signup challenges cannot create accounts without a passed age screen',
      );
      assert.equal(
        (await database.pool.query('SELECT id FROM users WHERE email = $1', [signupEmail]))
          .rowCount,
        0,
        'invalid/missing acceptance cannot create an account',
      );
      const deliveredBeforeAgeScreen = delivered.length;
      const underageEmail = 'underage-candidate@example.test';
      const minorDate = new Date();
      minorDate.setUTCFullYear(minorDate.getUTCFullYear() - 17);
      const underageRequest = await requestCode(
        appOne!,
        underageEmail,
        {
          ...signupRequest,
          dateOfBirth: minorDate.toISOString().slice(0, 10),
        },
        '192.0.2.49',
      );
      assert.equal(underageRequest.statusCode, 400);
      assert.equal(delivered.length, deliveredBeforeAgeScreen, 'underage signup sends no OTP');
      assert.equal(
        (await database.pool.query('SELECT id FROM users WHERE email = $1', [underageEmail]))
          .rowCount,
        0,
        'underage signup creates no account',
      );
      assert.equal(
        (
          await database.pool.query('SELECT id FROM email_otp_challenges WHERE email_hash = $1', [
            hashOtpEmail(underageEmail, secret),
          ])
        ).rowCount,
        0,
        'underage signup persists no OTP challenge',
      );
      const malformedDate = await requestCode(
        appOne!,
        'malformed-birthdate@example.test',
        { ...signupRequest, dateOfBirth: '2001-02-29' },
        '192.0.2.50',
      );
      assert.equal(malformedDate.statusCode, 400, 'invalid calendar dates are rejected');
      const signupSent = await requestCode(appOne!, signupEmail, signupRequest, '192.0.2.44');
      assert.equal(signupSent.statusCode, 202);
      assert.deepEqual(signupSent.json(), acceptedBody);
      const ageScreenChallenge = await database.pool.query<{ age_screen_passed: boolean | null }>(
        `SELECT age_screen_passed FROM email_otp_challenges WHERE email_hash = $1`,
        [hashOtpEmail(signupEmail, secret)],
      );
      assert.equal(ageScreenChallenge.rows[0]?.age_screen_passed, true);
      const signupChallenge = delivered.at(-1)!;
      const signupVerified = await verifyCode(
        appOne!,
        signupEmail,
        signupChallenge.code,
        { intent: 'sign-up' },
        '192.0.2.44',
      );
      assert.equal(signupVerified.statusCode, 200);
      assert.equal(signupVerified.json().authenticated, true);
      const signupSetCookies = signupVerified.headers['set-cookie'];
      const signupCookies = Array.isArray(signupSetCookies)
        ? signupSetCookies
        : [String(signupSetCookies)];
      const signupAccess = signupCookies
        .find((value) => value.startsWith('careerscope_v2_session='))!
        .split(';', 1)[0]!;
      const signupRefresh = signupCookies
        .find((value) => value.startsWith('careerscope_v2_refresh='))!
        .split(';', 1)[0]!;
      const signupCookieHeader = `${signupAccess}; ${signupRefresh}`;
      const newAccount = await database.pool.query<{
        email_verified_at: Date | null;
        password_hash: string | null;
        age_screen_passed: boolean | null;
      }>('SELECT email_verified_at, password_hash, age_screen_passed FROM users WHERE email = $1', [
        signupEmail,
      ]);
      assert.equal(newAccount.rowCount, 1);
      assert.ok(newAccount.rows[0]!.email_verified_at instanceof Date);
      assert.equal(newAccount.rows[0]!.password_hash, null);
      assert.equal(newAccount.rows[0]!.age_screen_passed, true);
      assert.equal(
        (
          await database.pool.query(
            `SELECT table_name FROM information_schema.columns
             WHERE table_schema = 'public' AND column_name = 'date_of_birth'
               AND table_name IN ('users', 'email_otp_challenges')`,
          )
        ).rowCount,
        0,
        'raw birth dates are not part of persistent account or challenge schema',
      );
      const signupAcceptances = await database.pool.query<{
        document: string;
        version: string;
        accepted: boolean;
        recorded_at: Date;
      }>(
        'SELECT document, version, accepted, recorded_at FROM account_acceptances WHERE owner_id = (SELECT id FROM users WHERE email = $1) ORDER BY document',
        [signupEmail],
      );
      assert.deepEqual(
        signupAcceptances.rows.map(({ document, version, accepted }) => ({
          document,
          version,
          accepted,
        })),
        [
          { document: 'marketing', version: 'marketing-test-1', accepted: true },
          { document: 'privacy_notice', version: 'privacy-test-1', accepted: true },
          { document: 'terms', version: 'terms-test-1', accepted: true },
        ],
      );
      assert.ok(signupAcceptances.rows.every((record) => record.recorded_at instanceof Date));
      const signupSession = await appOne!.inject({
        method: 'GET',
        url: '/api/session',
        headers: { cookie: signupCookieHeader },
      });
      const marketingState = await appOne!.inject({
        method: 'GET',
        url: '/api/account/marketing-consent',
        headers: { cookie: signupCookieHeader },
      });
      assert.equal(signupSession.statusCode, 200);
      assert.equal(marketingState.json().optedIn, true);
      const withdrawn = await appOne!.inject({
        method: 'POST',
        url: '/api/account/marketing-consent',
        headers: {
          origin,
          cookie: signupCookieHeader,
          'x-csrf-token': signupSession.json().csrf,
        },
        payload: { optIn: false },
      });
      assert.equal(withdrawn.statusCode, 200);
      assert.equal(withdrawn.json().optedIn, false);
      const marketingHistory = await database.pool.query<{
        accepted: boolean;
        sequence: string;
      }>(
        `SELECT accepted, sequence::text AS sequence FROM account_acceptances
         WHERE owner_id = (SELECT id FROM users WHERE email = $1) AND document = 'marketing'
         ORDER BY sequence`,
        [signupEmail],
      );
      assert.deepEqual(
        marketingHistory.rows.map(({ accepted }) => accepted),
        [true, false],
        'marketing consent history is append-only and read in deterministic database order',
      );
      assert.ok(
        BigInt(marketingHistory.rows[1]!.sequence) > BigInt(marketingHistory.rows[0]!.sequence),
      );

      await limiterOne.client.del(
        `${redisPrefix}otp:request:email-cooldown:${hashOtpEmail(signupEmail, secret)}`,
      );
      const duplicateSignup = await requestCode(
        appTwo!,
        signupEmail,
        { ...signupRequest, marketingOptIn: false },
        '192.0.2.45',
      );
      assert.equal(duplicateSignup.statusCode, 202);
      const duplicateChallenge = delivered.at(-1)!;
      const duplicateVerified = await verifyCode(
        appTwo!,
        signupEmail,
        duplicateChallenge.code,
        { intent: 'sign-up' },
        '192.0.2.45',
      );
      assert.equal(duplicateVerified.statusCode, 200);
      assert.equal(
        (
          await database.pool.query(
            `SELECT document, count(*)::int AS count FROM account_acceptances
             WHERE owner_id = (SELECT id FROM users WHERE email = $1)
             GROUP BY document ORDER BY document`,
            [signupEmail],
          )
        ).rowCount,
        3,
        'a repeated signup intent for an existing account must not duplicate or rewrite consent history',
      );

      const concurrentSignupEmail = 'concurrent-signup@example.test';
      const concurrentSignupSent = await requestCode(
        appOne!,
        concurrentSignupEmail,
        { ...signupRequest, marketingOptIn: false },
        '192.0.2.46',
      );
      assert.equal(concurrentSignupSent.statusCode, 202);
      const concurrentSignupChallenge = delivered.at(-1)!;
      const concurrentSignupVerifications = await Promise.all([
        verifyCode(
          appOne!,
          concurrentSignupEmail,
          concurrentSignupChallenge.code,
          { intent: 'sign-up' },
          '192.0.2.46',
        ),
        verifyCode(
          appTwo!,
          concurrentSignupEmail,
          concurrentSignupChallenge.code,
          { intent: 'sign-up' },
          '192.0.2.46',
        ),
      ]);
      assert.deepEqual(
        concurrentSignupVerifications.map((response) => response.statusCode).toSorted(),
        [200, 401],
        'only one concurrent verification may finalize a new account',
      );
      assert.equal(
        (
          await database.pool.query(
            `SELECT id FROM account_acceptances
             WHERE owner_id = (SELECT id FROM users WHERE email = $1)`,
            [concurrentSignupEmail],
          )
        ).rowCount,
        2,
        'concurrent signup finalization writes one Terms and one privacy acceptance',
      );

      const atomicSignupEmail = 'atomic-failure-signup@example.test';
      const atomicSignupRequest = await requestCode(
        appOne!,
        atomicSignupEmail,
        { ...signupRequest, marketingOptIn: false },
        '192.0.2.47',
      );
      assert.equal(atomicSignupRequest.statusCode, 202);
      const atomicSignupCode = delivered.at(-1)!;
      await database.pool.query(`
        CREATE FUNCTION reject_atomic_signup_acceptance() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF (SELECT email FROM users WHERE id = NEW.owner_id) = 'atomic-failure-signup@example.test'
             AND NEW.document = 'terms' THEN
            RAISE EXCEPTION 'synthetic acceptance persistence failure';
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER reject_atomic_signup_acceptance
        BEFORE INSERT ON account_acceptances
        FOR EACH ROW EXECUTE FUNCTION reject_atomic_signup_acceptance();
      `);
      const failedFinalize = await verifyCode(
        appOne!,
        atomicSignupEmail,
        atomicSignupCode.code,
        { intent: 'sign-up' },
        '192.0.2.47',
      );
      assert.equal(failedFinalize.statusCode, 503);
      assert.equal(
        (await database.pool.query('SELECT id FROM users WHERE email = $1', [atomicSignupEmail]))
          .rowCount,
        0,
        'failed acceptance persistence rolls back the new account',
      );
      assert.equal(
        (
          await database.pool.query('SELECT id FROM email_otp_challenges WHERE email_hash = $1', [
            hashOtpEmail(atomicSignupEmail, secret),
          ])
        ).rowCount,
        1,
        'failed account finalization rolls back challenge consumption',
      );
      await database.pool.query(`
        DROP TRIGGER reject_atomic_signup_acceptance ON account_acceptances;
        DROP FUNCTION reject_atomic_signup_acceptance();
      `);
      const retriedFinalize = await verifyCode(
        appOne!,
        atomicSignupEmail,
        atomicSignupCode.code,
        { intent: 'sign-up' },
        '192.0.2.47',
      );
      assert.equal(retriedFinalize.statusCode, 200);
      assert.equal(
        (
          await database.pool.query(
            `SELECT count(*)::int AS count FROM account_acceptances
             WHERE owner_id = (SELECT id FROM users WHERE email = $1)`,
            [atomicSignupEmail],
          )
        ).rows[0]!.count,
        2,
        'retry after transactional rollback creates one account with required acceptance records',
      );

      const changedEmail = 'candidate-updated@example.test';
      const emailChangeRequest = await appOne!.inject({
        method: 'POST',
        url: '/api/account/email-change/request',
        headers: {
          origin,
          cookie: rotatedAccessValue,
          'x-csrf-token': rotated.json().csrf,
        },
        payload: { newEmail: changedEmail },
      });
      assert.equal(emailChangeRequest.statusCode, 202);
      const currentAddressCode = delivered.at(-2)!;
      const newAddressCode = delivered.at(-1)!;
      assert.equal(currentAddressCode.purpose, 'email-change-current');
      assert.equal(newAddressCode.purpose, 'email-change-new');
      assert.equal(currentAddressCode.email, 'candidate@example.test');
      assert.equal(newAddressCode.email, changedEmail);
      assert.notEqual(currentAddressCode.code, newAddressCode.code);
      const persistedEmailChange = await database.pool.query<{
        current_digest: string;
        new_digest: string;
      }>('SELECT current_digest, new_digest FROM email_change_requests WHERE owner_id = $1', [
        candidateId,
      ]);
      assert.equal(persistedEmailChange.rowCount, 1);
      assert.notEqual(persistedEmailChange.rows[0]?.current_digest, currentAddressCode.code);
      assert.notEqual(persistedEmailChange.rows[0]?.new_digest, newAddressCode.code);

      const verifyEmailAddress = (address: 'current' | 'new', code: string) =>
        appOne!.inject({
          method: 'POST',
          url: '/api/account/email-change/verify',
          headers: {
            origin,
            cookie: rotatedAccessValue,
            'x-csrf-token': rotated.json().csrf,
          },
          payload: { address, code },
        });
      assert.equal(
        (await verifyEmailAddress('current', incorrect)).statusCode,
        401,
        'an invalid current-address code does not authorize the change',
      );
      const currentVerified = await verifyEmailAddress('current', currentAddressCode.code);
      assert.equal(currentVerified.statusCode, 200);
      assert.deepEqual(currentVerified.json(), { verified: 'current', emailChanged: false });
      assert.equal(
        (
          await database.pool.query('SELECT id FROM users WHERE id = $1 AND email = $2', [
            candidateId,
            'candidate@example.test',
          ])
        ).rowCount,
        1,
        'verifying only the current address does not change the account email',
      );
      const newVerified = await verifyEmailAddress('new', newAddressCode.code);
      assert.equal(newVerified.statusCode, 200);
      assert.deepEqual(newVerified.json(), { verified: 'new', emailChanged: true });
      assert.equal(
        (
          await database.pool.query('SELECT id FROM users WHERE id = $1 AND email = $2', [
            candidateId,
            changedEmail,
          ])
        ).rowCount,
        1,
        'the account email changes only after both address-bound codes are verified',
      );
      assert.equal(
        (await verifyEmailAddress('new', newAddressCode.code)).statusCode,
        401,
        'a completed email change cannot replay either code',
      );
      const changedSession = await appOne!.inject({
        method: 'GET',
        url: '/api/session',
        headers: { cookie: rotatedAccessValue },
      });
      assert.equal(changedSession.json().email, changedEmail);

      const publicApiDocs = await appOne!.inject({
        method: 'GET',
        url: '/api/docs/json',
        headers: { cookie: rotatedAccessValue },
      });
      assert.ok(publicApiDocs.json().paths['/api/account/email-change/request']?.post);
      assert.ok(publicApiDocs.json().paths['/api/account/email-change/verify']?.post);

      const docs = await appOne!.inject({
        method: 'GET',
        url: '/api/docs/json',
        headers: { cookie: rotatedAccessValue },
      });
      assert.equal(docs.statusCode, 200);
      const openapi = docs.json();
      assert.ok(openapi.paths['/api/otp/request']?.post);
      assert.ok(openapi.paths['/api/otp/verify']?.post);
      assert.ok(openapi.paths['/api/session/refresh']?.post);
      assert.ok(openapi.paths['/api/account/sessions']?.get);
      assert.ok(openapi.paths['/api/account/sessions/{id}']?.delete);
      assert.deepEqual(openapi.paths['/api/otp/request'].post.security, []);
      const requestVariants = openapi.paths['/api/otp/request'].post.requestBody.content[
        'application/json'
      ].schema.oneOf as Array<{
        properties: Record<string, { format?: string }>;
        required?: string[];
      }>;
      const signupContract = requestVariants.find((variant) =>
        variant.required?.includes('dateOfBirth'),
      );
      assert.equal(signupContract?.properties.dateOfBirth?.format, 'date');
      assert.ok(signupContract?.required?.includes('dateOfBirth'));
      assert.deepEqual(openapi.paths['/api/otp/verify'].post.security, []);
      assert.deepEqual(openapi.paths['/api/session/refresh'].post.security, [{ refresh: [] }]);
      const replayedRefresh = await appOne!.inject({
        method: 'POST',
        url: '/api/session/refresh',
        headers: { origin, cookie: refreshValue },
        payload: {},
      });
      assert.equal(
        replayedRefresh.statusCode,
        401,
        'reuse of a consumed refresh token is rejected',
      );
      const revoked = await appOne!.inject({
        method: 'GET',
        url: '/api/session',
        headers: { cookie: rotatedAccessValue },
      });
      assert.equal(
        revoked.json().authenticated,
        false,
        'reuse revokes the complete session family',
      );

      const unavailable = await createApp(
        database,
        origin,
        async () => {
          throw new Error('synthetic redis transport detail');
        },
        { emailOtp: { secret, provider } },
      );
      try {
        const failedRateLimit = await unavailable.inject({
          method: 'POST',
          url: '/api/otp/request',
          headers: { origin },
          payload: { email: 'candidate@example.test' },
        });
        assert.equal(failedRateLimit.statusCode, 503);
        assert.equal(failedRateLimit.json().message, 'Sign-in is temporarily unavailable');
        assert.equal(failedRateLimit.body.includes('synthetic redis transport detail'), false);
      } finally {
        await unavailable.close();
      }
    } finally {
      await appTwo?.close();
      await appOne?.close();
      const keys: string[] = [];
      for await (const batch of limiterOne.client.scanIterator({ MATCH: `${redisPrefix}*` }))
        keys.push(...batch);
      if (keys.length) await limiterOne.client.del(keys);
      await limiterTwo.close();
      await limiterOne.close();
      await database.close();
      await admin.pool.query(`DROP DATABASE "${name}"`);
      await admin.close();
    }
  },
);
