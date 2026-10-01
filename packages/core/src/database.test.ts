import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { createServer, type ServerResponse } from 'node:http';
import { runInNewContext } from 'node:vm';
import type { FastifyInstance, FastifySchema } from 'fastify';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { z } from 'zod';
import {
  Database,
  Conflict,
  ResumeUploadCancelled as PublishedResumeUploadCancelled,
  users,
  LeadRepository,
  ProfileRepository,
  sessionCookie,
  writableProfileSchema,
  logger,
} from '@careerscope/core';
import type { DerivedResume } from '@careerscope/shared';
import { buildCandidateContext } from '@careerscope/matching';
import { DeleteQueueCommand } from '@aws-sdk/client-sqs';
import { LocalQueue } from './queue.js';
import { executeBullCommand } from './bull-queue.js';
import { consumeMessage, publishPending, reconcileDeadLetter } from './dispatch.js';
import { Auth, passwordHash } from './auth.js';
// Deliberately from the PACKAGE, not './ai-provider.js': app.ts reaches the
// provider through '@careerscope/core', which resolves to the built dist. A
// relative source import here is a DIFFERENT module instance, so the base-URL
// redirect would not apply to the app under test - and the route would attempt
// a real OpenRouter call. Same instance, or the isolation is fictional.
import { _setBaseUrlForTests, _resetCatalogCacheForTests } from '@careerscope/core/ai-provider';
import { Conflict as ResumeConflict } from './errors.js';
import { PrivateFileResumeStorage } from './file-storage.js';
import {
  ResumeStorageLimit,
  ResumeUploadCoordinator,
  ResumeUploadRepository,
  resumeParseHandler,
} from './resumes.js';
import JSZip from 'jszip';
import { createApp } from '../../../apps/api/src/app.js';
import type { SourceOutcome } from './jobs.js';
import { searchHandler } from '../../../apps/workers/search/src/collect.js';
import { createRemoteOkProvider, createHimalayasProvider } from '@careerscope/providers';
import { createSearchSchema } from './commands.js';

function assertOpenApiRequiredDeclarations(document: unknown): void {
  assert.ok(document && typeof document === 'object' && !Array.isArray(document));
  const spec = document as Record<string, unknown>;
  assert.equal(spec.openapi, '3.0.3');
  assert.ok(spec.paths && typeof spec.paths === 'object' && !Array.isArray(spec.paths));
  assert.ok(Object.keys(spec.paths).length > 0);
  const visit = (value: unknown, path: string): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}/${index}`));
      return;
    }
    const node = value as Record<string, unknown>;
    if (Object.hasOwn(node, 'required')) {
      const required = node.required;
      if (typeof required !== 'boolean' || 'type' in node || 'properties' in node) {
        assert.ok(Array.isArray(required), `${path}/required must be an array`);
        assert.ok(required.length > 0, `${path}/required must not be empty`);
        assert.ok(
          required.every((entry) => typeof entry === 'string'),
          `${path}/required must contain strings`,
        );
        assert.equal(new Set(required).size, required.length, `${path}/required must be unique`);
      }
    }
    for (const [key, entry] of Object.entries(node)) visit(entry, `${path}/${key}`);
  };
  visit(spec, '#');
}

test('Swagger required-declaration check rejects empty and malformed input', () => {
  for (const document of [undefined, null, '', '{', [], {}, { openapi: '3.0.3', paths: {} }])
    assert.throws(() => assertOpenApiRequiredDeclarations(document));
  const document = (required: unknown) => ({
    openapi: '3.0.3',
    paths: {
      '/example': {
        post: {
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'object', properties: { name: { type: 'string' } }, required },
              },
            },
          },
        },
      },
    },
  });
  assert.doesNotThrow(() => assertOpenApiRequiredDeclarations(document(['name'])));
  for (const required of [[], null, undefined, 'name', {}, true, false, [123], ['name', 'name']])
    assert.throws(() => assertOpenApiRequiredDeclarations(document(required)), /required/);
});

test('Swagger documents every runtime route without changing validation and protects Try It Out', async () => {
  const configured = process.env.DATABASE_URL;
  assert.ok(configured);
  const base = new URL(configured);
  assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname));
  const admin = new Database(configured);
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  base.pathname = `/${name}`;
  const database = new Database(base.href);
  const origin = 'http://localhost:5280';
  try {
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL('../../../migrations', import.meta.url)),
    });
    const auth = new Auth(database);
    const password = randomUUID();
    await auth.register('swagger@example.test', password);
    const token = await auth.login('swagger@example.test', password);
    assert.ok(token);
    const session = await auth.session(token);
    assert.ok(session);
    const cookie = `careerscope_v2_session=${token}`;
    const headers = { cookie, origin, 'x-csrf-token': session.csrf };
    for (const capability of ['disabled', 'storage', 'cancellation'] as const) {
      const routes = new Map<string, FastifySchema | undefined>();
      const observe = (message: unknown) => {
        const { fastify } = message as { fastify: FastifyInstance };
        fastify.addHook('onRoute', (route) => {
          for (const method of [route.method].flat()) {
            if (method !== 'HEAD' && !route.url.startsWith('/api/docs'))
              routes.set(
                `${method.toLowerCase()} ${route.url.replace(/:([a-zA-Z]+)/g, '{$1}')}`,
                route.schema,
              );
          }
        });
      };
      const initialization = channel('fastify.initialization');
      initialization.subscribe(observe);
      let app: Awaited<ReturnType<typeof createApp>>;
      const unexpectedStorage = async (): Promise<never> => {
        throw new Error('No object IO expected');
      };
      try {
        app = await createApp(database, origin, async () => true, {
          registrationEnabled: capability === 'cancellation',
          ...(capability === 'disabled'
            ? {}
            : {
                resumeStorage: {
                  bucket: 'synthetic-swagger',
                  initialize: unexpectedStorage,
                  put: unexpectedStorage,
                  get: unexpectedStorage,
                  recoverVersion: unexpectedStorage,
                  delete: unexpectedStorage,
                  ...(capability === 'cancellation' ? { cancelUpload: unexpectedStorage } : {}),
                },
              }),
        });
        await app.ready();
      } finally {
        initialization.unsubscribe(observe);
      }
      try {
        for (const url of [
          '/api/docs',
          '/api/docs/',
          '/api/docs/json',
          '/api/docs/yaml',
          '/api/docs/static/index.html',
          '/api/docs/static/swagger-initializer.js',
          '/api/docs/static/swagger-ui.css',
          '/api/docs/static/swagger-ui-bundle.js',
          '/api/docs/static/swagger-ui-standalone-preset.js',
          '/api/docs/static/oauth2-redirect.html',
          '/api/docs/static/missing.js',
          '/api/docs/static/%2e%2e/package.json',
        ]) {
          for (const method of ['GET', 'HEAD'] as const) {
            assert.equal((await app.inject({ method, url })).statusCode, 401, `${method} ${url}`);
            assert.equal(
              (
                await app.inject({
                  method,
                  url,
                  headers: { cookie: 'careerscope_v2_session=invalid' },
                })
              ).statusCode,
              401,
            );
          }
        }
        const result = await app.inject({ url: '/api/docs/json', headers: { cookie } });
        assert.equal(result.statusCode, 200);
        assert.equal(result.headers['cache-control'], 'no-store');
        const spec = result.json();
        assertOpenApiRequiredDeclarations(spec);
        const malformedSpec = structuredClone(spec);
        malformedSpec.paths['/api/profile'].put.requestBody.content[
          'application/json'
        ].schema.properties.profile.properties.application.required = [];
        assert.throws(() => assertOpenApiRequiredDeclarations(malformedSpec), /required/);
        assert.equal(spec.openapi, '3.0.3');
        assert.equal(spec.info.version, (await app.inject('/api/health')).json().version);
        assert.deepEqual(spec.servers, [{ url: '/' }]);
        assert.equal(spec.components.securitySchemes.session.name, 'careerscope_v2_session');
        const documented = Object.entries(spec.paths).flatMap(([url, methods]) =>
          Object.keys(methods as object).map((method) => `${method} ${url}`),
        );
        assert.ok(routes.size >= 30);
        assert.deepEqual(documented.sort(), [...routes.keys()].sort());
        for (const [route, schema] of routes) {
          assert.equal(schema?.body, undefined, route);
          assert.equal(schema?.response, undefined, route);
          assert.equal(schema?.params, undefined, route);
          assert.equal(schema?.querystring, undefined, route);
        }
        for (const methods of Object.values(spec.paths)) {
          for (const operation of Object.values(
            methods as Record<string, { summary: string; responses: Record<string, unknown> }>,
          )) {
            assert.ok(operation.summary.length > 5);
            assert.ok(operation.responses['500']);
            // Redirect-only authentication routes (Cognito start/callback)
            // truthfully document 302 rather than inventing a JSON 200. A
            // 2xx response is required for ordinary operations; a documented
            // 3xx is the successful terminal response for redirect routes.
            assert.ok(
              Object.keys(operation.responses).some(
                (code) => code.startsWith('2') || code.startsWith('3'),
              ),
            );
          }
        }
        assert.deepEqual(spec.paths['/api/health'].get.security, []);
        assert.deepEqual(spec.paths['/api/profile'].put.security, [{ session: [], csrf: [] }]);
        assert.ok(spec.paths['/api/account/password'].post.responses['204']);
        assert.equal(spec.paths['/api/account/password'].post.responses['204'].content, undefined);
        assert.ok(
          spec.paths['/api/searches/{id}/events'].get.responses['200'].content['text/event-stream'],
        );
        assert.ok(spec.paths['/api/resumes'].post.requestBody.content['application/octet-stream']);
        assert.equal(spec.paths['/api/resumes/{id}/cancel'].post.requestBody.required, false);
        assert.ok(spec.paths['/api/resumes'].post.responses['507']);
        assert.deepEqual(
          spec.paths['/api/resumes/{id}'].get.responses['200'].content['application/json'].schema
            .properties.result.oneOf[0],
          { type: 'object', nullable: true, enum: [null] },
        );
        assert.ok(
          spec.paths['/api/searches'].post.parameters.some(
            (parameter: { name: string; required: boolean }) =>
              parameter.name === 'idempotency-key' && parameter.required,
          ),
        );
        assert.deepEqual(
          spec.paths['/api/leads/{id}'].put.requestBody.content['application/json'].schema
            .properties.status.enum,
          ['saved', 'applied', 'interviewing', 'offer', 'rejected', 'archived'],
        );
        assert.match(
          spec.paths['/api/resumes'].post.description,
          capability === 'disabled' ? /Uploads disabled/ : /Uploads enabled/,
        );
        assert.match(
          spec.paths['/api/resumes/{id}/cancel'].post.description,
          capability === 'cancellation' ? /Cancellation enabled/ : /Cancellation disabled/,
        );
        assert.match(
          spec.paths['/api/register'].post.description,
          capability === 'cancellation' ? /Registration is enabled/ : /Registration is disabled/,
        );
        for (const secret of [token, session.csrf, password, 'swagger@example.test'])
          assert.equal(result.body.includes(secret), false);

        const ui = await app.inject({ url: '/api/docs/', headers: { cookie } });
        assert.equal(ui.statusCode, 200);
        assert.match(ui.body, /swagger-ui/);
        const csp = String(ui.headers['content-security-policy']);
        assert.match(csp, /connect-src 'self'/);
        assert.match(csp, /script-src 'self';/);
        assert.match(csp, /frame-ancestors 'none'/);
        assert.doesNotMatch(csp, /unsafe-eval|validator\.swagger|https:/);
        for (const url of [
          '/api/docs/static/swagger-ui.css',
          '/api/docs/static/swagger-ui-bundle.js',
          '/api/docs/static/swagger-ui-standalone-preset.js',
        ]) {
          const asset = await app.inject({ url, headers: { cookie } });
          assert.equal(asset.statusCode, 200, url);
          assert.equal(asset.headers['cache-control'], 'no-store', url);
        }
        assert.equal(
          (await app.inject({ url: '/api/docs/yaml', headers: { cookie } })).statusCode,
          200,
        );
        const profile = await app.inject({ url: '/api/profile', headers: { cookie } });
        assert.match(String(profile.headers['content-security-policy']), /default-src 'none'/);
        assert.doesNotMatch(
          String(profile.headers['content-security-policy']),
          /connect-src|style-src-attr/,
        );
        assert.deepEqual(profile.json(), {
          revision: 0,
          profile: null,
          updatedAt: null,
          scheduledDiscoveryEnabled: false,
        });

        const initializer = await app.inject({
          url: '/api/docs/static/swagger-initializer.js',
          headers: { cookie },
        });
        let config:
          | {
              requestInterceptor: (
                request: Record<string, unknown>,
              ) => Promise<{ headers: Record<string, string>; credentials: string }>;
              persistAuthorization: boolean;
              validatorUrl: unknown;
              queryConfigEnabled: boolean;
              showMutatedRequest: boolean;
            }
          | undefined;
        const bundle = Object.assign(
          (value: typeof config) => {
            config = value;
            return { initOAuth() {} };
          },
          { presets: { apis: {} }, plugins: { DownloadUrl: {} } },
        );
        let sessionBody: unknown = { authenticated: true, csrf: session.csrf };
        let fetchCount = 0;
        const browser = {
          window: { location: { origin, href: `${origin}/api/docs/` }, onload: () => {} },
          URL,
          document: { createElement: () => ({ href: '' }) },
          SwaggerUIBundle: bundle,
          SwaggerUIStandalonePreset: {},
          fetch: async (
            url: string,
            options: { credentials: string; cache: string; redirect: string },
          ) => {
            assert.equal(url, '/api/session');
            assert.equal(options.credentials, 'same-origin');
            assert.equal(options.cache, 'no-store');
            assert.equal(options.redirect, 'error');
            fetchCount++;
            return { ok: true, json: async () => sessionBody };
          },
        };
        runInNewContext(initializer.body, browser);
        browser.window.onload();
        assert.ok(config);
        assert.equal(config.persistAuthorization, false);
        assert.equal(config.validatorUrl, null);
        assert.equal(config.queryConfigEnabled, false);
        assert.equal(config.showMutatedRequest, false);
        const request = await config.requestInterceptor({
          url: '/api/account/sessions/revoke-others',
          method: 'POST',
          headers: {},
        });
        assert.equal(request.credentials, 'same-origin');
        assert.equal(request.headers['x-csrf-token'], session.csrf);
        assert.equal(
          (
            await app.inject({
              method: 'POST',
              url: '/api/account/sessions/revoke-others',
              headers: { cookie, origin, ...request.headers },
              payload: {},
            })
          ).statusCode,
          204,
        );
        const readsBefore = fetchCount;
        await config.requestInterceptor({ url: '/api/profile', method: 'GET', headers: {} });
        await config.requestInterceptor({ url: '/api/login', method: 'POST', headers: {} });
        assert.equal(fetchCount, readsBefore);
        await assert.rejects(
          config.requestInterceptor({
            url: 'https://other.example/api/profile',
            method: 'POST',
            headers: {},
          }),
          /same-origin/,
        );
        await assert.rejects(
          config.requestInterceptor({ url: '/outside', method: 'POST', headers: {} }),
          /same-origin/,
        );
        for (const malformed of [
          { authenticated: false },
          { authenticated: true },
          { authenticated: true, csrf: 123 },
          { authenticated: true, csrf: '' },
        ]) {
          sessionBody = malformed;
          await assert.rejects(
            config.requestInterceptor({ url: '/api/logout', method: 'POST', headers: {} }),
            /Sign in again/,
          );
        }
        for (const invalidHeaders of [
          { cookie, origin },
          { cookie, origin, 'x-csrf-token': 'wrong' },
          { cookie, 'x-csrf-token': session.csrf },
          { cookie, origin: 'https://other.example', 'x-csrf-token': session.csrf },
        ]) {
          assert.equal(
            (
              await app.inject({
                method: 'POST',
                url: '/api/account/sessions/revoke-others',
                headers: invalidHeaders,
                payload: {},
              })
            ).statusCode,
            403,
          );
        }
        assert.equal(
          (
            await app.inject({
              method: 'POST',
              url: '/api/account/sessions/revoke-others',
              headers,
              payload: { extra: true },
            })
          ).statusCode,
          400,
        );
        assert.equal(
          (
            await app.inject({
              method: 'POST',
              url: '/api/account/sessions/revoke-others',
              headers: { ...headers, 'content-type': 'application/json' },
              payload: '{',
            })
          ).statusCode,
          400,
        );
        const resumes = await app.inject({ url: '/api/resumes', headers });
        assert.equal(resumes.statusCode, 200);
        assert.equal(resumes.json().enabled, capability !== 'disabled');
        const missingId = randomUUID();
        assert.equal(
          (await app.inject({ url: `/api/resumes/${missingId}`, headers })).statusCode,
          capability === 'disabled' ? 503 : 404,
        );
        assert.equal(
          (
            await app.inject({
              method: 'POST',
              url: `/api/resumes/${missingId}/cancel`,
              headers,
              payload: {},
            })
          ).statusCode,
          capability === 'cancellation' ? 404 : 503,
        );
      } finally {
        await app.close();
      }
    }
  } finally {
    await database.close();
    await admin.pool.query(`DROP DATABASE "${name}"`);
    await admin.close();
  }
});

test('market and pipeline HTTP routes preserve evidence, query bounds and owner isolation', async (context) => {
  const configured = process.env.DATABASE_URL;
  assert.ok(configured);
  const base = new URL(configured);
  assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname));
  const admin = new Database(configured);
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  base.pathname = `/${name}`;
  const database = new Database(base.href);
  const origin = 'http://localhost:5280';
  try {
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL('../../../migrations', import.meta.url)),
    });
    const ownerId = randomUUID();
    const otherOwnerId = randomUUID();
    const password = randomUUID();
    const hash = await passwordHash(password);
    await database.db.insert(users).values(
      [ownerId, otherOwnerId].map((id) => ({
        id,
        email: `${id}@example.test`,
        passwordHash: hash,
      })),
    );
    const app = await createApp(database, origin, async () => true);
    try {
      const login = async (id: string) => {
        const response = await app.inject({
          method: 'POST',
          url: '/api/login',
          headers: { origin },
          payload: { email: `${id}@example.test`, password },
        });
        assert.equal(response.statusCode, 200);
        const cookie = response.cookies.find((entry) => entry.name === 'careerscope_v2_session');
        assert.ok(cookie);
        return { [cookie.name]: cookie.value };
      };
      const cookies = await login(ownerId);
      const otherCookies = await login(otherOwnerId);
      const get = async (url: string, sessionCookies = cookies) => {
        const response = await app.inject({ method: 'GET', url, cookies: sessionCookies });
        assert.equal(response.statusCode, 200, url);
        assert.equal(response.headers['cache-control'], 'no-store');
        return response.json();
      };
      const denied = async (url: string) => {
        // Annotated, not inferred: `[{}, { careerscope_v2_session: 'invalid' }]`
        // infers as a union that Fastify's inject options reject, and the
        // resulting error cascaded into `response` typing as the un-awaited
        // Chain — which is why statusCode/json/headers below were all errors
        // rather than checked. The assertions ran; nothing type-checked them.
        const variants: Record<string, string>[] = [{}, { careerscope_v2_session: 'invalid' }];
        for (const sessionCookies of variants) {
          const response = await app.inject({ url, cookies: sessionCookies });
          assert.equal(response.statusCode, 401, url);
          assert.equal(response.json().error, 'Authentication required');
          assert.equal(typeof response.json().requestId, 'string');
          assert.equal(response.headers['cache-control'], 'no-store');
        }
      };
      for (const url of ['/api/market/postings', '/api/market/companies', '/api/pipeline/stalled'])
        assert.deepEqual(await get(url), { entries: [] });
      assert.deepEqual(await get('/api/pipeline'), { stages: [], stalledActive: 0 });

      const clock = (await database.pool.query<{ now: Date }>('SELECT now() AS now')).rows[0]!;
      const ago = (days: number) =>
        new Date(clock.now.getTime() - (days + 0.5) * 86_400_000).toISOString();
      const longOpen = {
        fingerprint: 'shared-posting',
        title: 'Backend Engineer',
        company: 'Synthetic Acme',
        sightings: 4,
        repostCount: 0,
        firstSeenAt: ago(35),
        lastSeenAt: ago(0),
        firstPostedAt: ago(90),
        daysOpen: 90,
        daysTracked: 35,
        signals: ['long_open', 'persistent'],
      };
      const reposted = {
        ...longOpen,
        fingerprint: 'reposted',
        sightings: 2,
        repostCount: 1,
        firstSeenAt: ago(5),
        firstPostedAt: ago(10),
        daysOpen: 10,
        daysTracked: 5,
        signals: ['reposted'],
      };
      const fresh = {
        ...longOpen,
        fingerprint: 'fresh',
        sightings: 1,
        firstSeenAt: ago(0),
        firstPostedAt: ago(1),
        daysOpen: 1,
        daysTracked: 0,
        signals: ['recently_posted', 'first_sighting'],
      };
      const undated = {
        ...fresh,
        fingerprint: 'undated',
        company: 'Synthetic Other',
        firstPostedAt: null,
        daysOpen: null,
        signals: ['first_sighting'],
      };
      const foreign = {
        ...longOpen,
        company: 'Foreign Company',
        title: 'Foreign Role',
        sightings: 9,
        repostCount: 3,
        signals: ['reposted', 'long_open', 'persistent'],
      };
      const foreignOnly = { ...foreign, fingerprint: 'foreign-only' };
      for (const [id, evidence] of [
        ...[longOpen, reposted, fresh, undated, { ...undated, fingerprint: 'undated-second' }].map(
          (entry) => [ownerId, entry] as const,
        ),
        [otherOwnerId, foreign] as const,
        [otherOwnerId, foreignOnly] as const,
      ]) {
        await database.pool.query(
          `INSERT INTO job_sightings
            (owner_id, fingerprint, title, company, sightings, repost_count,
             first_seen_at, last_seen_at, first_posted_at, last_posted_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
          [
            id,
            evidence.fingerprint,
            evidence.title,
            evidence.company,
            evidence.sightings,
            evidence.repostCount,
            evidence.firstSeenAt,
            evidence.lastSeenAt,
            evidence.firstPostedAt,
          ],
        );
      }
      const lead = async (
        id: string,
        fingerprint: string,
        status: string,
        days: number,
        notes = '',
      ) => {
        const entry = {
          id: randomUUID(),
          fingerprint,
          status,
          hasNotes: notes !== '',
          statusChangedAt: ago(days),
          daysSinceChange: days,
          title: 'Synthetic Engineer',
          company: id === ownerId ? 'Synthetic Acme' : 'Foreign Company',
        };
        await database.pool.query(
          `INSERT INTO saved_leads
            (id, owner_id, fingerprint, data, status, status_changed_at, notes)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
          [
            entry.id,
            id,
            fingerprint,
            JSON.stringify({ title: entry.title, company: entry.company }),
            status,
            entry.statusChangedAt,
            notes,
          ],
        );
        return entry;
      };
      const applied = await lead(
        ownerId,
        'shared-posting',
        'applied',
        40,
        'Private synthetic note',
      );
      const interviewing = await lead(ownerId, 'interview', 'interviewing', 30);
      const saved = await lead(ownerId, 'fresh-lead', 'saved', 2);
      const oldest = await lead(ownerId, 'old-lead', 'saved', 400);
      await lead(ownerId, 'rejected', 'rejected', 90);
      await lead(ownerId, 'archived', 'archived', 90);
      const foreignLead = await lead(
        otherOwnerId,
        'shared-posting',
        'applied',
        120,
        'Foreign note',
      );

      await context.test(
        'GET /api/market/postings filters, limits and isolates evidence',
        async () => {
          const url = '/api/market/postings';
          await denied(url);
          const expected = { entries: [longOpen, reposted] };
          assert.deepEqual(await get(url), expected);
          assert.deepEqual(await get(`${url}?limit=1`), { entries: [longOpen] });
          assert.deepEqual(await get(`${url}?limit=1.9`), { entries: [longOpen] });
          for (const limit of ['nonsense', '0', '-1', 'Infinity', '1&limit=2'])
            assert.deepEqual(await get(`${url}?limit=${limit}`), expected);
          assert.deepEqual(await get(`${url}?ownerId=${otherOwnerId}`), expected);
          const other = await get(url, otherCookies);
          assert.deepEqual(
            other.entries.sort((left: { fingerprint: string }, right: { fingerprint: string }) =>
              left.fingerprint.localeCompare(right.fingerprint),
            ),
            [foreignOnly, foreign],
          );
        },
      );

      await context.test(
        'GET /api/market/postings/:fingerprint validates and isolates lookup',
        async () => {
          const url = '/api/market/postings/shared-posting';
          await denied(url);
          assert.deepEqual(await get(url), longOpen);
          assert.deepEqual(await get(url, otherCookies), foreign);
          assert.deepEqual(await get(`${url}?ownerId=${otherOwnerId}`), longOpen);
          assert.deepEqual(await get('/api/market/postings/fresh'), fresh);
          assert.deepEqual(await get('/api/market/postings/undated'), undated);
          assert.deepEqual(
            await get('/api/market/postings/foreign-only', otherCookies),
            foreignOnly,
          );
          const missing = await app.inject({ url: '/api/market/postings/missing', cookies });
          const hidden = await app.inject({ url: '/api/market/postings/foreign-only', cookies });
          for (const response of [missing, hidden]) {
            assert.equal(response.statusCode, 404);
            assert.equal(response.json().error, 'No sightings recorded for this posting');
          }
          const invalid = await app.inject({ url: '/api/market/postings/%E0%A4%A', cookies });
          assert.equal(invalid.statusCode, 400);
        },
      );

      await context.test(
        'GET /api/market/companies aggregates only the session owner',
        async () => {
          const url = '/api/market/companies';
          await denied(url);
          const entries = [
            {
              company: 'Synthetic Acme',
              postings: 3,
              reposts: 1,
              mostSightings: 4,
              averageDaysOpen: 34,
              lastSeenAt: ago(0),
            },
            {
              company: 'Synthetic Other',
              postings: 2,
              reposts: 0,
              mostSightings: 1,
              averageDaysOpen: null,
              lastSeenAt: ago(0),
            },
          ];
          assert.deepEqual(await get(url), { entries });
          assert.deepEqual(await get(`${url}?limit=1`), { entries: entries.slice(0, 1) });
          for (const limit of ['nonsense', '0', '-1', 'Infinity', '1&limit=2'])
            assert.deepEqual(await get(`${url}?limit=${limit}`), { entries });
          assert.deepEqual(await get(`${url}?ownerId=${otherOwnerId}`), { entries });
          assert.deepEqual(await get(url, otherCookies), {
            entries: [
              {
                company: 'Foreign Company',
                postings: 2,
                reposts: 6,
                mostSightings: 9,
                averageDaysOpen: 90,
                lastSeenAt: ago(0),
              },
            ],
          });
        },
      );

      await context.test(
        'GET /api/pipeline counts stages without treating finished work as active',
        async () => {
          const url = '/api/pipeline';
          await denied(url);
          const expected = {
            stages: [
              { status: 'applied', count: 1, oldestDays: 40, stalled: 1 },
              { status: 'archived', count: 1, oldestDays: 90, stalled: 1 },
              { status: 'interviewing', count: 1, oldestDays: 30, stalled: 1 },
              { status: 'rejected', count: 1, oldestDays: 90, stalled: 1 },
              { status: 'saved', count: 2, oldestDays: 400, stalled: 1 },
            ],
            stalledActive: 3,
          };
          assert.deepEqual(await get(url), expected);
          assert.deepEqual(await get(`${url}?ownerId=${otherOwnerId}&days=nonsense`), expected);
          assert.deepEqual(await get(url, otherCookies), {
            stages: [{ status: 'applied', count: 1, oldestDays: 120, stalled: 1 }],
            stalledActive: 1,
          });
        },
      );

      await context.test(
        'GET /api/pipeline/stalled bounds queries and omits private notes',
        async () => {
          const url = '/api/pipeline/stalled';
          await denied(url);
          const expected = { entries: [oldest, applied, interviewing] };
          assert.deepEqual(await get(url), expected);
          assert.deepEqual(await get(`${url}?limit=1`), { entries: [oldest] });
          assert.deepEqual(await get(`${url}?days=35`), { entries: [oldest, applied] });
          assert.deepEqual(await get(`${url}?days=365`), { entries: [oldest] });
          assert.deepEqual(await get(`${url}?days=9999`), { entries: [oldest] });
          assert.deepEqual(await get(`${url}?days=-1`), {
            entries: [oldest, applied, interviewing, saved],
          });
          for (const days of ['nonsense', '0', '1&days=2'])
            assert.deepEqual(await get(`${url}?days=${days}`), expected);
          for (const limit of ['nonsense', '0', '-1', 'Infinity', '1&limit=2'])
            assert.deepEqual(await get(`${url}?limit=${limit}`), expected);
          assert.deepEqual(await get(`${url}?ownerId=${otherOwnerId}`), expected);
          assert.deepEqual(await get(url, otherCookies), { entries: [foreignLead] });
        },
      );
    } finally {
      await app.close();
    }
  } finally {
    await database.pool.end();
    await admin.pool.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.pool.end();
  }
});

test('global resume reservation budgets serialize across owners and preserve retries', async () => {
  const configured = process.env.DATABASE_URL;
  assert.ok(configured);
  const base = new URL(configured);
  assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname));
  const admin = new Database(configured);
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  base.pathname = `/${name}`;
  const database = new Database(base.href);
  try {
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL('../../../migrations', import.meta.url)),
    });
    const owners = [randomUUID(), randomUUID(), randomUUID()];
    for (const owner of owners) {
      await database.pool.query(
        'INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)',
        [owner, `${owner}@example.test`, 'synthetic-not-a-login'],
      );
    }
    const uploads = new ResumeUploadRepository(database);
    const metadata = { sha256: 'a'.repeat(64), bytes: 100, contentType: 'application/pdf' };
    const seed = (count: number, bytes: number) =>
      database.pool.query(
        `
      INSERT INTO resume_uploads (id, owner_id, idempotency_key, bucket, sha256, bytes, content_type)
      SELECT gen_random_uuid(), $1, 'synthetic-budget-' || series, 'synthetic-resumes', $2, $3, 'application/pdf'
      FROM generate_series(1, $4) AS series`,
        [owners[0], metadata.sha256, bytes, count],
      );
    await seed(999, 100);
    const countRace = await Promise.allSettled(
      owners
        .slice(1)
        .map((owner) => uploads.reserve(owner!, 'count-boundary', 'synthetic-resumes', metadata)),
    );
    assert.equal(countRace.filter((result) => result.status === 'fulfilled').length, 1);
    const countRejection = countRace.find((result) => result.status === 'rejected');
    assert.ok(countRejection?.status === 'rejected');
    assert.ok(countRejection.reason instanceof ResumeStorageLimit);
    const winner = countRace.find((result) => result.status === 'fulfilled');
    assert.ok(winner?.status === 'fulfilled');
    assert.equal(
      (await uploads.reserve(winner.value.ownerId, 'count-boundary', 'synthetic-resumes', metadata))
        .id,
      winner.value.id,
    );
    assert.equal(
      (await database.pool.query('SELECT count(*) FROM resume_uploads')).rows[0].count,
      '1000',
    );
    const auth = new Auth(database);
    const password = randomUUID();
    await auth.register('capacity@example.test', password);
    const token = await auth.login('capacity@example.test', password);
    assert.ok(token);
    const session = await auth.session(token);
    assert.ok(session);
    let storageCalls = 0;
    const unexpectedStorage = async (): Promise<never> => {
      storageCalls += 1;
      throw new Error('Capacity must reject before storage IO');
    };
    const origin = 'http://localhost:5280';
    const app = await createApp(database, origin, async () => true, {
      resumeStorage: {
        bucket: 'synthetic-resumes',
        initialize: unexpectedStorage,
        put: unexpectedStorage,
        get: unexpectedStorage,
        recoverVersion: unexpectedStorage,
        delete: unexpectedStorage,
      },
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/resumes',
        headers: {
          origin,
          cookie: `careerscope_v2_session=${token}`,
          'x-csrf-token': session.csrf,
          'content-type': 'application/octet-stream',
          'idempotency-key': 'capacity-denied',
        },
        payload: Buffer.from('%PDF-1.7 synthetic capacity document'),
      });
      assert.equal(response.statusCode, 507);
      assert.equal(response.json().error, 'Resume storage capacity reached');
      assert.equal(storageCalls, 0);
      assert.equal(
        (await database.pool.query('SELECT count(*) FROM resume_uploads')).rows[0].count,
        '1000',
      );
    } finally {
      await app.close();
    }
    await assert.rejects(
      uploads.reserve(winner.value.ownerId, 'count-boundary', 'synthetic-resumes', {
        ...metadata,
        bytes: 101,
      }),
      ResumeConflict,
    );
    await database.pool.query(
      "DELETE FROM resume_uploads WHERE idempotency_key LIKE 'synthetic-budget-%'",
    );
    await uploads.reserve(owners[1]!, 'capacity-released', 'synthetic-resumes', metadata);
    await database.pool.query('DELETE FROM resume_uploads');
    await seed(204, 5 * 1024 * 1024);
    const bytesRace = await Promise.allSettled(
      owners.slice(1).map((owner) =>
        uploads.reserve(owner!, 'bytes-boundary', 'synthetic-resumes', {
          ...metadata,
          bytes: 3 * 1024 * 1024,
        }),
      ),
    );
    assert.equal(bytesRace.filter((result) => result.status === 'fulfilled').length, 1);
    const bytesRejection = bytesRace.find((result) => result.status === 'rejected');
    assert.ok(bytesRejection?.status === 'rejected');
    assert.ok(bytesRejection.reason instanceof ResumeStorageLimit);
    assert.equal(
      Number(
        (await database.pool.query('SELECT sum(bytes) AS bytes FROM resume_uploads')).rows[0].bytes,
      ),
      1023 * 1024 * 1024,
    );
    const exactMetadata = { ...metadata, bytes: 1024 * 1024 };
    const exact = await uploads.reserve(
      owners[1]!,
      'exact-byte-ceiling',
      'synthetic-resumes',
      exactMetadata,
    );
    assert.equal(
      Number(
        (await database.pool.query('SELECT sum(bytes) AS bytes FROM resume_uploads')).rows[0].bytes,
      ),
      1024 * 1024 * 1024,
    );
    assert.equal(
      (await uploads.reserve(owners[1]!, 'exact-byte-ceiling', 'synthetic-resumes', exactMetadata))
        .id,
      exact.id,
    );
    await assert.rejects(
      uploads.reserve(owners[2]!, 'one-byte-over', 'synthetic-resumes', { ...metadata, bytes: 1 }),
      ResumeStorageLimit,
    );
    await database.pool.query('DELETE FROM resume_uploads WHERE id = $1', [exact.id]);
    await uploads.reserve(owners[2]!, 'one-byte-over', 'synthetic-resumes', {
      ...metadata,
      bytes: 1,
    });
    assert.equal(
      Number(
        (await database.pool.query('SELECT sum(bytes) AS bytes FROM resume_uploads')).rows[0].bytes,
      ),
      1023 * 1024 * 1024 + 1,
    );
    assert.equal(
      (await database.pool.query('SELECT count(*) FROM outbox_events')).rows[0].count,
      '0',
    );
  } finally {
    await database.close();
    await admin.pool.query(`DROP DATABASE "${name}"`);
    await admin.close();
  }
});

test('password changes revoke sessions and serialize with login and competing changes', async () => {
  const configured = process.env.DATABASE_URL;
  assert.ok(configured);
  const base = new URL(configured);
  assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname));
  const admin = new Database(configured);
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  base.pathname = `/${name}`;
  const database = new Database(base.href);
  try {
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL('../../../migrations', import.meta.url)),
    });
    const auth = new Auth(database);
    const password = randomUUID();
    const replacement = randomUUID();
    await auth.register('security@example.test', password);
    await auth.register('other@example.test', password);
    const original = await auth.login('security@example.test', password);
    const other = await auth.login('other@example.test', password);
    assert.ok(original);
    assert.ok(other);
    const session = await auth.session(original);
    assert.ok(session);
    assert.equal(await auth.changePassword(session.ownerId, randomUUID(), replacement), false);
    assert.equal(await auth.changePassword(session.ownerId, password, password), false);
    await assert.rejects(auth.changePassword(session.ownerId, password, 'short'));
    assert.ok(await auth.session(original));
    const [changed, racedLogin] = await Promise.all([
      auth.changePassword(session.ownerId, password, replacement),
      auth.login('security@example.test', password),
    ]);
    assert.equal(changed, true);
    assert.equal(await auth.session(original), null);
    if (racedLogin) assert.equal(await auth.session(racedLogin), null);
    assert.ok(await auth.session(other));
    assert.equal(await auth.login('security@example.test', password), null);
    const newSession = await auth.login('security@example.test', replacement);
    assert.ok(newSession);
    const contenders = [randomUUID(), randomUUID()];
    const results = await Promise.all(
      contenders.map((value) => auth.changePassword(session.ownerId, replacement, value)),
    );
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(await auth.session(newSession), null);
    const activePassword = contenders[results.indexOf(true)]!;
    const activeToken = await auth.login('security@example.test', activePassword);
    assert.ok(activeToken);
    assert.equal(
      await auth.login('security@example.test', contenders[results.indexOf(false)]!),
      null,
    );
    let admission: 'allow' | 'deny' | 'offline' = 'allow';
    const origin = 'http://localhost:5280';
    const app = await createApp(database, origin, async () => {
      if (admission === 'offline') throw new Error('Synthetic throttle failure');
      return admission === 'allow';
    });
    try {
      const current = await auth.session(activeToken);
      assert.ok(current);
      const headers = {
        origin,
        cookie: `careerscope_v2_session=${activeToken}`,
        'x-csrf-token': current.csrf,
      };
      const payload = { currentPassword: activePassword, newPassword: randomUUID() };
      const secondToken = await auth.login('security@example.test', activePassword);
      assert.ok(secondToken);
      const revoke = (overrides = {}) =>
        app.inject({
          method: 'POST',
          url: '/api/account/sessions/revoke-others',
          headers,
          payload: {},
          ...overrides,
        });
      assert.equal((await revoke({ headers: { origin } })).statusCode, 401);
      assert.equal(
        (await revoke({ headers: { ...headers, origin: 'https://foreign.example.test' } }))
          .statusCode,
        403,
      );
      assert.equal((await revoke({ headers: { ...headers, 'x-csrf-token': '' } })).statusCode, 403);
      assert.equal((await revoke({ payload: { ownerId: randomUUID() } })).statusCode, 400);
      admission = 'deny';
      assert.equal((await revoke()).statusCode, 429);
      admission = 'offline';
      assert.equal((await revoke()).statusCode, 500);
      assert.ok(await auth.session(secondToken));
      admission = 'allow';
      assert.equal(await auth.revokeOtherSessions(randomUUID(), activeToken), false);
      assert.equal((await revoke()).statusCode, 204);
      assert.ok(await auth.session(activeToken));
      assert.ok(await auth.session(other));
      assert.equal(await auth.session(secondToken), null);
      assert.equal(await auth.revokeOtherSessions(current.ownerId, secondToken), false);
      assert.equal((await revoke()).statusCode, 204);
      for (const firstOperation of ['revoke', 'login'] as const) {
        const older = await auth.login('security@example.test', activePassword);
        assert.ok(older);
        const gate = await database.pool.connect();
        const operations: Promise<unknown>[] = [];
        const waitFor = async (query: string, parameters: unknown[] = []) => {
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            if ((await database.pool.query<{ ready: boolean }>(query, parameters)).rows[0]?.ready)
              return;
            await delay(25);
          }
          assert.fail('Auth concurrency barrier was not reached');
        };
        await database.pool.query(`
          CREATE FUNCTION test_session_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN PERFORM pg_advisory_xact_lock(7654322);
            IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
          END $$;
          CREATE TRIGGER test_session_barrier BEFORE ${firstOperation === 'revoke' ? 'DELETE' : 'INSERT'} ON sessions
          FOR EACH ROW EXECUTE FUNCTION test_session_barrier();
        `);
        try {
          await gate.query('SELECT pg_advisory_lock(7654322)');
          // Annotated because the conditional's two branches return different
          // promise types and TypeScript could not close the inference, leaving
          // these `any`. The runtime assertions below always ran — `any`
          // disables type checking, not execution — but nothing verified that
          // `firstResult` can be a boolean while `loginToken` must be a string,
          // which is the whole point of the interleaving being tested.
          const first: Promise<boolean | string | null> =
            firstOperation === 'revoke'
              ? auth.revokeOtherSessions(current.ownerId, activeToken)
              : auth.login('security@example.test', activePassword);
          operations.push(first);
          await waitFor(
            "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=7654322 AND NOT granted) AS ready",
          );
          const second: Promise<boolean | string | null> =
            firstOperation === 'revoke'
              ? auth.login('security@example.test', activePassword)
              : auth.revokeOtherSessions(current.ownerId, activeToken);
          operations.push(second);
          await waitFor(
            'SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND query=$1 AND cardinality(pg_blocking_pids(pid))>0) AS ready',
            [
              firstOperation === 'revoke'
                ? 'SELECT password_hash FROM users WHERE id = $1 FOR UPDATE'
                : 'SELECT id FROM users WHERE id = $1 FOR UPDATE',
            ],
          );
          await gate.query('SELECT pg_advisory_unlock(7654322)');
          const [firstResult, secondResult] = await Promise.all([first, second]);
          const loginToken = firstOperation === 'revoke' ? secondResult : firstResult;
          assert.equal(firstOperation === 'revoke' ? firstResult : secondResult, true);
          assert.equal(typeof loginToken, 'string');
          assert.equal(
            Boolean(await auth.session(loginToken as string)),
            firstOperation === 'revoke',
          );
          assert.ok(await auth.session(activeToken));
          assert.ok(await auth.session(other));
          assert.equal(await auth.session(older), null);
        } finally {
          await gate.query('SELECT pg_advisory_unlock_all()');
          gate.release();
          await Promise.allSettled(operations);
          await database.pool.query(
            'DROP TRIGGER test_session_barrier ON sessions; DROP FUNCTION test_session_barrier()',
          );
        }
      }
      const send = (overrides = {}) =>
        app.inject({
          method: 'POST',
          url: '/api/account/password',
          headers,
          payload,
          ...overrides,
        });
      assert.equal((await send({ headers: { origin } })).statusCode, 401);
      assert.equal(
        (await send({ headers: { ...headers, origin: 'https://foreign.example.test' } }))
          .statusCode,
        403,
      );
      assert.equal((await send({ headers: { ...headers, 'x-csrf-token': '' } })).statusCode, 403);
      assert.equal(
        (await send({ payload: { ...payload, ownerId: randomUUID() } })).statusCode,
        400,
      );
      assert.equal(
        (await send({ payload: { ...payload, currentPassword: randomUUID() } })).statusCode,
        400,
      );
      admission = 'deny';
      assert.equal((await send()).statusCode, 429);
      admission = 'offline';
      assert.equal((await send()).statusCode, 500);
      assert.ok(await auth.session(activeToken));
      admission = 'allow';
      const response = await send();
      assert.equal(response.statusCode, 204);
      assert.match(String(response.headers['set-cookie']), /careerscope_v2_session=;/);
      assert.equal(await auth.session(activeToken), null);
      assert.ok(await auth.session(other));
      assert.equal((await send()).statusCode, 401);
      assert.ok(await auth.login('security@example.test', payload.newPassword));
    } finally {
      await app.close();
    }
  } finally {
    await database.close();
    // Do not let cleanup manufacture an uncaught client failure that replaces
    // the assertion which brought us here. pool.end() must prove this test owns
    // no remaining connection; a plain DROP fails diagnostically if it does.
    await admin.pool.query(`DROP DATABASE "${name}"`);
    await admin.close();
  }
});

test('registration is atomic, normalizes email and cannot replace another account', async () => {
  const configured = process.env.DATABASE_URL;
  assert.ok(configured);
  const base = new URL(configured);
  assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname));
  const admin = new Database(configured);
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  base.pathname = `/${name}`;
  const database = new Database(base.href);
  try {
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL('../../../migrations', import.meta.url)),
    });
    const auth = new Auth(database);
    const password = randomUUID();
    await Promise.all([
      auth.register(' First@Example.test ', password),
      auth.register('first@example.test', password),
    ]);
    await auth.register('first@example.test', 'another-synthetic-password');
    await auth.register('second@example.test', password);
    assert.equal((await database.pool.query('SELECT id FROM users')).rowCount, 2);
    assert.equal(await auth.login('first@example.test', 'another-synthetic-password'), null);
    const firstToken = await auth.login('first@example.test', password);
    const secondToken = await auth.login('second@example.test', password);
    assert.ok(firstToken);
    assert.ok(secondToken);
    const first = await auth.session(firstToken);
    const second = await auth.session(secondToken);
    assert.ok(first);
    assert.ok(second);
    assert.notEqual(first.ownerId, second.ownerId);
    const run = await database.createSearch(first.ownerId, 'isolated-account-search', {
      query: 'Synthetic',
      sources: ['remoteok'],
    });
    assert.equal(await database.getSearch(second.ownerId, run.id), undefined);
    await assert.rejects(auth.register('invalid', password));
    await assert.rejects(auth.register('third@example.test', 'short'));
    await assert.rejects(auth.createOwner('third@example.test', password), /already configured/);
    const origin = 'http://localhost:5280';
    const disabled = await createApp(database, origin, async () => true);
    try {
      const response = await disabled.inject({
        method: 'POST',
        url: '/api/register',
        headers: { origin },
        payload: { email: 'third@example.test', password },
      });
      assert.equal(response.statusCode, 404);
      assert.equal((await disabled.inject('/api/session')).json().registrationEnabled, false);
    } finally {
      await disabled.close();
    }
    let limitMode: 'allow' | 'deny' | 'offline' = 'allow';
    const enabled = await createApp(
      database,
      origin,
      async () => {
        if (limitMode === 'offline') throw new Error('Synthetic limiter unavailable');
        return limitMode === 'allow';
      },
      { registrationEnabled: true },
    );
    try {
      assert.equal((await enabled.inject('/api/session')).json().registrationEnabled, true);
      const payload = { email: 'third@example.test', password };
      assert.equal(
        (await enabled.inject({ method: 'POST', url: '/api/register', payload })).statusCode,
        403,
      );
      assert.equal(
        (
          await enabled.inject({
            method: 'POST',
            url: '/api/register',
            headers: { origin },
            payload: { ...payload, ownerId: first.ownerId },
          })
        ).statusCode,
        400,
      );
      const firstSignup = await enabled.inject({
        method: 'POST',
        url: '/api/register',
        headers: { origin },
        payload,
      });
      const duplicate = await enabled.inject({
        method: 'POST',
        url: '/api/register',
        headers: { origin },
        payload,
      });
      assert.equal(firstSignup.statusCode, 202);
      assert.equal(duplicate.statusCode, 202);
      assert.equal(firstSignup.body, duplicate.body);
      assert.equal(firstSignup.headers['set-cookie'], undefined);
      assert.equal((await enabled.inject('/api/profile')).statusCode, 401);
      const login = await enabled.inject({
        method: 'POST',
        url: '/api/login',
        headers: { origin },
        payload,
      });
      assert.equal(login.statusCode, 200);
      const cookie = String(login.headers['set-cookie']).split(';')[0]!;
      assert.match(String(login.headers['set-cookie']), /HttpOnly/i);
      assert.match(String(login.headers['set-cookie']), /SameSite=Strict/i);
      assert.equal(
        (
          await enabled.inject({
            method: 'POST',
            url: '/api/searches',
            headers: { origin, cookie },
            payload: {},
          })
        ).statusCode,
        403,
      );
      limitMode = 'deny';
      assert.equal(
        (
          await enabled.inject({
            method: 'POST',
            url: '/api/register',
            headers: { origin },
            payload: { email: 'blocked@example.test', password },
          })
        ).statusCode,
        429,
      );
      limitMode = 'offline';
      assert.equal(
        (
          await enabled.inject({
            method: 'POST',
            url: '/api/register',
            headers: { origin },
            payload: { email: 'offline@example.test', password },
          })
        ).statusCode,
        500,
      );
      assert.equal((await database.pool.query('SELECT id FROM users')).rowCount, 3);
    } finally {
      await enabled.close();
    }
    const directory = await mkdtemp(join(tmpdir(), 'careerscope-upload-api-'));
    const storage = new PrivateFileResumeStorage({ directory, encryptionKey: 'a'.repeat(64) });
    const uploadApp = await createApp(database, origin, async () => true, {
      resumeStorage: storage,
    });
    try {
      await storage.initialize();
      const headers = {
        origin,
        cookie: `careerscope_v2_session=${firstToken}`,
        'x-csrf-token': first.csrf,
        'idempotency-key': 'synthetic-upload-api',
        'content-type': 'application/octet-stream',
      };
      const archive = new JSZip();
      archive.file(
        '[Content_Types].xml',
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      );
      archive.file(
        'word/document.xml',
        '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic Candidate, React and TypeScript developer with experience building accessible web applications.</w:t></w:r></w:p></w:body></w:document>',
      );
      const payload = await archive.generateAsync({ type: 'nodebuffer' });
      assert.equal(
        (
          await uploadApp.inject({
            method: 'POST',
            url: '/api/resumes',
            headers: { origin, 'content-type': 'application/octet-stream' },
            payload,
          })
        ).statusCode,
        401,
      );
      assert.equal(
        (
          await uploadApp.inject({
            method: 'POST',
            url: '/api/resumes',
            headers: { ...headers, 'x-csrf-token': '' },
            payload,
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await uploadApp.inject({
            method: 'POST',
            url: '/api/resumes',
            headers,
            payload: Buffer.from('invalid'),
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await uploadApp.inject({
            method: 'POST',
            url: '/api/resumes',
            headers,
            payload: Buffer.alloc(5 * 1024 * 1024 + 1),
          })
        ).statusCode,
        413,
      );
      await database.pool
        .query(`CREATE FUNCTION reject_upload_publication() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'synthetic publication failure'; END $$`);
      await database.pool
        .query(`CREATE TRIGGER reject_upload_publication BEFORE INSERT ON outbox_events
        FOR EACH ROW EXECUTE FUNCTION reject_upload_publication()`);
      assert.equal(
        (await uploadApp.inject({ method: 'POST', url: '/api/resumes', headers, payload }))
          .statusCode,
        500,
      );
      await database.pool.query('DROP TRIGGER reject_upload_publication ON outbox_events');
      const interruptedList = (await uploadApp.inject({ url: '/api/resumes', headers })).json();
      assert.equal(interruptedList.items.length, 1);
      assert.equal(interruptedList.items[0].status, 'uploading');
      const recoveryUrl = `/api/resumes/${interruptedList.items[0].id}/recover`;
      assert.equal(
        (await uploadApp.inject({ method: 'POST', url: recoveryUrl, headers: { origin } }))
          .statusCode,
        401,
      );
      assert.equal(
        (
          await uploadApp.inject({
            method: 'POST',
            url: recoveryUrl,
            headers: { ...headers, 'x-csrf-token': '' },
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await uploadApp.inject({
            method: 'POST',
            url: recoveryUrl,
            headers: {
              ...headers,
              cookie: `careerscope_v2_session=${secondToken}`,
              'x-csrf-token': second.csrf,
            },
          })
        ).statusCode,
        404,
      );
      const recovered = await uploadApp.inject({ method: 'POST', url: recoveryUrl, headers });
      assert.equal(recovered.statusCode, 200);
      assert.equal(recovered.json().status, 'queued');
      assert.deepEqual(
        (await uploadApp.inject({ method: 'POST', url: recoveryUrl, headers })).json(),
        recovered.json(),
      );
      const accepted = await uploadApp.inject({
        method: 'POST',
        url: '/api/resumes',
        headers,
        payload,
      });
      assert.equal(accepted.statusCode, 202);
      const uploadId = accepted.json().id;
      assert.equal(
        (await uploadApp.inject({ method: 'DELETE', url: `/api/resumes/${uploadId}`, headers }))
          .statusCode,
        409,
      );
      assert.deepEqual(
        (await uploadApp.inject({ method: 'POST', url: '/api/resumes', headers, payload })).json(),
        accepted.json(),
      );
      assert.equal(
        (
          await uploadApp.inject({
            url: `/api/resumes/${uploadId}`,
            headers: { cookie: `careerscope_v2_session=${secondToken}` },
          })
        ).statusCode,
        404,
      );
      const record = await new ResumeUploadRepository(database).get(first.ownerId, uploadId);
      assert.ok(record?.commandId);
      const command = await database.command(record.commandId);
      assert.ok(command);
      const fence = await database.claim(command.id);
      assert.ok(fence);
      assert.equal(
        await resumeParseHandler(database, storage)(command, fence, new AbortController().signal),
        true,
      );
      const detail = (await uploadApp.inject({ url: `/api/resumes/${uploadId}`, headers })).json();
      assert.equal(detail.status, 'parsed');
      assert.ok(detail.result.parsed.derived.techStack.includes('React'));
      const list = (await uploadApp.inject({ url: '/api/resumes', headers })).json();
      assert.equal(list.items.length, 1);
      assert.equal(list.items[0].status, 'parsed');
      assert.equal(JSON.stringify(list).includes(storage.bucket), false);
      assert.equal(
        (
          await database.pool.query('SELECT owner_id FROM candidate_profiles WHERE owner_id = $1', [
            first.ownerId,
          ])
        ).rowCount,
        0,
      );
      const repository = new ResumeUploadRepository(database);
      for (const phase of ['before-write', 'after-write']) {
        const entered = Promise.withResolvers<string>();
        const release = Promise.withResolvers<void>();
        const paused = new ResumeUploadCoordinator(repository, {
          bucket: storage.bucket,
          initialize: storage.initialize.bind(storage),
          get: storage.get.bind(storage),
          recoverVersion: storage.recoverVersion.bind(storage),
          put: async (object, body, signal) => {
            if (phase === 'before-write') {
              entered.resolve(object.resumeId);
              await release.promise;
              return storage.put(object, body, signal);
            }
            const version = await storage.put(object, body, signal);
            entered.resolve(object.resumeId);
            await release.promise;
            return version;
          },
        });
        const attempt = paused.upload(first.ownerId, `cancel-${phase}`, payload);
        const settledAttempt = attempt.then(
          () => null,
          (error: unknown) => error,
        );
        const id = await entered.promise;
        const url = `/api/resumes/${id}/cancel`;
        // Annotated: `first` is narrowed by an assertion function two scopes
        // up, and deriving this object from that narrowing left it `any` —
        // which meant the header set sent to a CSRF-protected cancel route was
        // not type-checked at all, in the test whose subject is that route's
        // auth behaviour. The assertions ran; the headers were unchecked.
        const cancelHeaders: Record<string, string> = {
          origin,
          cookie: headers.cookie,
          'x-csrf-token': first.csrf,
        };
        try {
          assert.equal(
            (await uploadApp.inject({ method: 'POST', url, headers: { origin } })).statusCode,
            401,
          );
          assert.equal(
            (
              await uploadApp.inject({
                method: 'POST',
                url,
                headers: { ...headers, 'x-csrf-token': '' },
              })
            ).statusCode,
            403,
          );
          assert.equal(
            (
              await uploadApp.inject({
                method: 'POST',
                url,
                headers: { ...headers, origin: 'https://foreign.example' },
              })
            ).statusCode,
            403,
          );
          assert.equal(
            (
              await uploadApp.inject({
                method: 'POST',
                url,
                headers: {
                  ...cancelHeaders,
                  cookie: `careerscope_v2_session=${secondToken}`,
                  'x-csrf-token': second.csrf,
                },
              })
            ).statusCode,
            404,
          );
          assert.equal((await repository.get(first.ownerId, id))?.status, 'uploading');
          const cancellation = await uploadApp.inject({
            method: 'POST',
            url,
            headers: cancelHeaders,
          });
          assert.equal(cancellation.statusCode, 200);
          assert.equal(cancellation.json().status, 'cancelled');
          assert.equal(
            (await uploadApp.inject({ method: 'POST', url, headers: cancelHeaders })).json().status,
            'cancelled',
          );
          assert.equal(
            (
              await uploadApp.inject({ method: 'POST', url: `/api/resumes/${id}/recover`, headers })
            ).json().status,
            'cancelled',
          );
          assert.equal(
            (
              await database.pool.query(
                "SELECT id FROM outbox_events WHERE command->>'aggregateId' = $1",
                [id],
              )
            ).rowCount,
            0,
          );
        } finally {
          release.resolve();
          await settledAttempt;
        }
        assert.ok((await settledAttempt) instanceof ResumeConflict);
        assert.equal((await repository.get(first.ownerId, id))?.status, 'cancelled');
      }
      assert.ok(new PublishedResumeUploadCancelled('synthetic boundary check') instanceof Conflict);
      assert.equal(
        (
          await uploadApp.inject({
            method: 'POST',
            url: `/api/resumes/${uploadId}/cancel`,
            headers: { origin, cookie: headers.cookie, 'x-csrf-token': first.csrf },
          })
        ).statusCode,
        409,
      );
      await assert.rejects(
        repository.deleteSettled(first.ownerId, uploadId, async () => {
          throw new Error('Synthetic delete failure');
        }),
      );
      assert.ok(await repository.result(first.ownerId, uploadId));
      assert.equal(
        (
          await uploadApp.inject({
            method: 'DELETE',
            url: `/api/resumes/${uploadId}`,
            headers: {
              ...headers,
              cookie: `careerscope_v2_session=${secondToken}`,
              'x-csrf-token': second.csrf,
            },
          })
        ).statusCode,
        204,
      );
      assert.ok(await repository.get(first.ownerId, uploadId));
      assert.equal(
        (await uploadApp.inject({ method: 'DELETE', url: `/api/resumes/${uploadId}`, headers }))
          .statusCode,
        204,
      );
      assert.equal(
        (await uploadApp.inject({ method: 'DELETE', url: `/api/resumes/${uploadId}`, headers }))
          .statusCode,
        204,
      );
      assert.equal(await repository.get(first.ownerId, uploadId), null);
      assert.equal(await repository.result(first.ownerId, uploadId), null);
      assert.equal(
        await storage.recoverVersion({
          ownerId: first.ownerId,
          resumeId: uploadId,
          bytes: record.bytes,
          sha256: record.sha256,
          contentType: record.contentType,
        }),
        null,
      );
      const stored = Promise.withResolvers<string>();
      const releaseUpload = Promise.withResolvers<void>();
      const racing = new ResumeUploadCoordinator(repository, {
        bucket: storage.bucket,
        initialize: storage.initialize.bind(storage),
        get: storage.get.bind(storage),
        recoverVersion: storage.recoverVersion.bind(storage),
        put: async (object, body, signal) => {
          const version = await storage.put(object, body, signal);
          stored.resolve(object.resumeId);
          await releaseUpload.promise;
          return version;
        },
      });
      const racingUpload = racing.upload(first.ownerId, 'racing-recovery-upload', payload);
      let racingId: string;
      try {
        racingId = await stored.promise;
        const response = await uploadApp.inject({
          method: 'POST',
          url: `/api/resumes/${racingId}/recover`,
          headers,
        });
        assert.equal(response.statusCode, 200);
        assert.equal(response.json().status, 'queued');
      } finally {
        releaseUpload.resolve();
      }
      const completedUpload = await racingUpload;
      assert.equal(completedUpload?.id, racingId);
      assert.equal(
        (
          await database.pool.query(
            "SELECT id FROM outbox_events WHERE command->>'aggregateId' = $1",
            [racingId],
          )
        ).rowCount,
        1,
      );
      const racingCommand = await database.command(completedUpload!.commandId!);
      assert.ok(racingCommand);
      const racingFence = await database.claim(racingCommand.id);
      assert.ok(racingFence);
      assert.equal(
        await resumeParseHandler(database, storage)(
          racingCommand,
          racingFence,
          new AbortController().signal,
        ),
        true,
      );
      assert.equal((await repository.result(first.ownerId, racingId))?.status, 'parsed');

      const waiting = await repository.reserve(
        first.ownerId,
        'aborted-recovery-upload',
        storage.bucket,
        {
          sha256: 'c'.repeat(64),
          bytes: 100,
          contentType: 'application/pdf',
        },
      );
      const enteredRecovery = Promise.withResolvers<void>();
      const abortedRecovery = Promise.withResolvers<void>();
      const abortApp = await createApp(database, origin, async () => true, {
        resumeStorage: {
          bucket: storage.bucket,
          initialize: storage.initialize.bind(storage),
          get: storage.get.bind(storage),
          put: storage.put.bind(storage),
          delete: storage.delete.bind(storage),
          recoverVersion: async (_object, signal) => {
            enteredRecovery.resolve();
            await new Promise<void>((_resolve, reject) => {
              const abort = () => {
                abortedRecovery.resolve();
                reject(signal!.reason);
              };
              if (signal!.aborted) abort();
              else signal!.addEventListener('abort', abort, { once: true });
            });
            return null;
          },
        },
      });
      const requestAbort = new AbortController();
      try {
        const address = await abortApp.listen({ host: '127.0.0.1', port: 0 });
        const request = fetch(`${address}/api/resumes/${waiting.id}/recover`, {
          method: 'POST',
          headers,
          signal: requestAbort.signal,
        });
        const failedRequest = assert.rejects(request);
        await enteredRecovery.promise;
        requestAbort.abort();
        await failedRequest;
        await abortedRecovery.promise;
        assert.equal((await repository.get(first.ownerId, waiting.id))?.status, 'uploading');
        assert.equal(
          (
            await database.pool.query(
              "SELECT id FROM outbox_events WHERE command->>'aggregateId' = $1",
              [waiting.id],
            )
          ).rowCount,
          0,
        );
      } finally {
        requestAbort.abort();
        await abortApp.close();
      }
      const metadata = { sha256: 'b'.repeat(64), bytes: 100, contentType: 'application/pdf' };
      for (let index = 0; index < 49; index += 1)
        await repository.reserve(
          second.ownerId,
          `quota-fixture-${index}`,
          storage.bucket,
          metadata,
        );
      const competing = await Promise.allSettled(
        Array.from({ length: 3 }, (_, index) =>
          repository.reserve(second.ownerId, `quota-final-${index}`, storage.bucket, metadata),
        ),
      );
      assert.equal(competing.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(
        (
          await database.pool.query('SELECT id FROM resume_uploads WHERE owner_id = $1', [
            second.ownerId,
          ])
        ).rowCount,
        50,
      );
      assert.ok(
        await repository.reserve(second.ownerId, 'quota-fixture-0', storage.bucket, metadata),
      );
    } finally {
      await uploadApp.close();
      storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  } finally {
    await database.close();
    try {
      await admin.pool.query(`DROP DATABASE "${name}"`);
    } finally {
      await admin.close();
    }
  }
});

test('partial search outcomes are atomic, owner-scoped, terminal and usable through the API', async () => {
  const configured = process.env.DATABASE_URL;
  assert.ok(configured);
  const base = new URL(configured);
  assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname));
  const admin = new Database(configured);
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  base.pathname = `/${name}`;
  const database = new Database(base.href);
  const previousMigrations = await mkdtemp(join(tmpdir(), 'careerscope-migration-'));
  try {
    const migrationsFolder = fileURLToPath(new URL('../../../migrations', import.meta.url));
    const journal = JSON.parse(
      await readFile(join(migrationsFolder, 'meta/_journal.json'), 'utf8'),
    ) as { entries: { idx: number; tag: string }[] };
    journal.entries = journal.entries.filter((entry) => entry.idx <= 6);
    await mkdir(join(previousMigrations, 'meta'));
    await writeFile(join(previousMigrations, 'meta/_journal.json'), JSON.stringify(journal));
    for (const entry of journal.entries)
      await copyFile(
        join(migrationsFolder, `${entry.tag}.sql`),
        join(previousMigrations, `${entry.tag}.sql`),
      );
    await migrate(database.db, { migrationsFolder: previousMigrations });
    const historicalOwner = randomUUID();
    const historicalRun = randomUUID();
    await database.pool.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [
      historicalOwner,
      `${historicalOwner}@example.test`,
      'synthetic',
    ]);
    await database.pool.query(
      `INSERT INTO search_runs (id, owner_id, request, request_hash, idempotency_key, status)
      VALUES ($1, $2, $3::jsonb, 'synthetic', 'historical', 'completed')`,
      [historicalRun, historicalOwner, JSON.stringify({ query: 'React', sources: ['remoteok'] })],
    );
    await migrate(database.db, { migrationsFolder });
    await migrate(database.db, { migrationsFolder });
    const historical = await database.getSearch(historicalOwner, historicalRun);
    assert.equal(historical?.status, 'completed');
    assert.equal(historical?.sourceOutcomes, null);
    const ownerId = randomUUID();
    const otherOwner = randomUUID();
    const password = randomUUID();
    const hash = await passwordHash(password);
    await database.db.insert(users).values(
      [ownerId, otherOwner].map((id) => ({
        id,
        email: `${id}@example.test`,
        passwordHash: hash,
      })),
    );
    const request = {
      query: 'React',
      sources: ['remoteok', 'himalayas'] as ['remoteok', 'himalayas'],
    };
    const search = await database.createSearch(ownerId, 'partial-result-test', request);
    const command = (await database.unpublished())[0]!.command;
    const first = await database.claim(command.id);
    assert.ok(first);
    await database.release(command.id, first);
    const fence = await database.claim(command.id);
    assert.ok(fence);
    const job = {
      fingerprint: 'partial-test',
      sourceJobId: 'partial-test',
      title: 'React Engineer',
      company: 'Synthetic',
      location: 'Remote',
      description: 'Validated partial result',
      source: 'remoteok' as const,
      sourceUrl: 'https://remoteok.com/remote-jobs/synthetic',
      applyUrl: 'https://example.test/apply',
      postedAt: null,
    };
    const outcomes: SourceOutcome[] = [
      { source: 'remoteok', status: 'completed', accepted: 1, limited: false, errorCode: null },
      {
        source: 'himalayas',
        status: 'failed',
        accepted: 0,
        limited: false,
        errorCode: 'source_failed',
      },
    ];
    assert.equal(await database.completeCollection(command, first, [job], outcomes), false);
    assert.equal(await database.startSearch(command, first), false);
    assert.equal(await database.startSearch({ ...command, ownerId: otherOwner }, fence), false);
    assert.equal(await database.startSearch(command, fence), true);
    assert.equal(await database.startSearch(command, fence), true);
    await assert.rejects(
      database.completeCollection(
        command,
        fence,
        [
          {
            ...job,
            sourceLinks: [{ source: 'lever', url: 'https://jobs.lever.co/synthetic/123' }],
          },
        ],
        outcomes,
      ),
      Conflict,
    );
    assert.equal(
      await database.completeCollection(
        { ...command, ownerId: otherOwner },
        fence,
        [job],
        outcomes,
      ),
      false,
    );
    await assert.rejects(
      database.completeCollection(command, fence, [job], outcomes.slice(0, 1)),
      Conflict,
    );
    await assert.rejects(
      database.completeCollection(
        command,
        fence,
        [job, { ...job, fingerprint: 'second' }],
        [outcomes[0]!, { ...outcomes[1]!, accepted: 1 }],
      ),
      Conflict,
    );
    await assert.rejects(
      database.completeCollection(command, fence, [job], [outcomes[0]!, outcomes[0]!]),
      /./,
    );
    await database.pool
      .query(`CREATE FUNCTION reject_partial_event() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.type = 'SearchPartial' THEN RAISE EXCEPTION 'synthetic rollback'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_partial_event BEFORE INSERT ON run_events FOR EACH ROW EXECUTE FUNCTION reject_partial_event()`);
    await assert.rejects(
      database.completeCollection(command, fence, [job], outcomes),
      /synthetic rollback/,
    );
    assert.equal((await database.getSearch(ownerId, search.id))?.status, 'running');
    assert.equal((await database.getSearch(ownerId, search.id))?.sourceOutcomes, null);
    assert.equal(
      (await database.pool.query('SELECT id FROM search_jobs WHERE run_id = $1', [search.id]))
        .rowCount,
      0,
    );
    assert.equal(await database.executionStatus(command.id), 'running');
    await database.pool.query(
      'DROP TRIGGER reject_partial_event ON run_events; DROP FUNCTION reject_partial_event()',
    );
    assert.equal(await database.completeCollection(command, fence, [job], outcomes), true);
    assert.equal(await database.executionStatus(command.id), 'completed');
    assert.deepEqual((await database.getSearch(ownerId, search.id))?.sourceOutcomes, outcomes);
    for (const count of [3, 4, 5]) {
      const sources = (['remoteok', 'himalayas', 'greenhouse', 'lever', 'workable'] as const).slice(
        0,
        count,
      );
      const expanded = await database.createSearch(ownerId, `expanded-sources-${count}`, {
        query: 'React',
        sources,
      });
      const expandedCommand = (await database.unpublished()).find(
        (entry) => entry.command.aggregateId === expanded.id,
      )!.command;
      const expandedFence = await database.claim(expandedCommand.id);
      assert.ok(expandedFence);
      const expandedOutcomes: SourceOutcome[] = sources.map((source) => ({
        source,
        status: 'completed',
        accepted: source === 'remoteok' ? 1 : 0,
        limited: false,
        errorCode: null,
      }));
      assert.equal(
        await database.completeCollection(expandedCommand, expandedFence, [job], expandedOutcomes),
        true,
      );
      assert.deepEqual(
        (await database.getSearch(ownerId, expanded.id))?.sourceOutcomes,
        expandedOutcomes,
      );
      assert.equal(await database.getSearch(otherOwner, expanded.id), undefined);
      assert.equal(
        await database.completeCollection(expandedCommand, expandedFence, [job], expandedOutcomes),
        false,
      );
    }
    assert.equal((await database.cancelSearch(ownerId, search.id))?.status, 'partial');
    assert.equal(await database.fail(command, fence), false);
    assert.equal(await database.claim(command.id), null);
    const terminal = await database.pool.query(
      "SELECT type FROM run_events WHERE run_id = $1 AND type <> 'SearchQueued'",
      [search.id],
    );
    assert.deepEqual(terminal.rows, [{ type: 'SearchStarted' }, { type: 'SearchPartial' }]);
    const origin = 'http://localhost:5280';
    const app = await createApp(database, origin, async () => true);
    try {
      const otherToken = await new Auth(database).login(`${otherOwner}@example.test`, password);
      assert.ok(otherToken);
      const login = await app.inject({
        method: 'POST',
        url: '/api/login',
        headers: { origin },
        payload: { email: `${ownerId}@example.test`, password },
      });
      const sessionCookie = login.cookies[0]!;
      const cookies = { [sessionCookie.name]: sessionCookie.value };
      const detail = await app.inject({ url: `/api/searches/${search.id}`, cookies });
      assert.equal(detail.statusCode, 200);
      assert.equal(detail.json().status, 'partial');
      assert.deepEqual(detail.json().sourceOutcomes, outcomes);
      const exported = await app.inject({ url: `/api/searches/${search.id}/export`, cookies });
      assert.equal(exported.statusCode, 200);
      assert.equal(exported.json().status, 'partial');
      assert.deepEqual(exported.json().sourceOutcomes, outcomes);
      assert.equal(exported.json().jobs.length, 1);
      for (const suffix of ['', '/export']) {
        const url = `/api/searches/${search.id}${suffix}`;
        assert.equal((await app.inject(url)).statusCode, 401);
        assert.equal(
          (await app.inject({ url, cookies: { [sessionCookie.name]: otherToken } })).statusCode,
          404,
        );
      }
      const jobId = detail.json().jobs[0].id;
      const leads = new LeadRepository(database);
      const savedLead = await leads.save(ownerId, { jobId });
      assert.ok(savedLead);
      assert.equal(await leads.save(otherOwner, { jobId }), null);

      // CS-33 (Security review, 2026-09-24): every read surface over stored
      // job/lead facts must independently enforce the shared, validated
      // projection - not merely trust that only settle()/save() ever wrote
      // this column. Simulate writes that bypass both settle() and save()
      // (direct SQL updates, standing in for a future migration, backfill
      // or admin tool) and confirm every one of the three read routes over
      // that same data handles it safely - an unrecognized extra field is
      // silently stripped (collectedJobSchema's .strip() mode, by design,
      // not an error condition), while a genuinely broken required field
      // fails loudly with no field content leaked, exactly like the
      // already-existing export route.
      await database.pool.query(
        `UPDATE search_jobs SET data = data || '{"unexpectedField": "should never reach a client"}'::jsonb WHERE id = $1`,
        [jobId],
      );
      for (const url of [`/api/searches/${search.id}`, `/api/searches/${search.id}/export`]) {
        const stripped = await app.inject({ url, cookies });
        assert.equal(stripped.statusCode, 200);
        assert.ok(!JSON.stringify(stripped.json()).includes('unexpectedField'));
      }
      await database.pool.query(`UPDATE search_jobs SET data = data - 'title' WHERE id = $1`, [
        jobId,
      ]);
      for (const url of [`/api/searches/${search.id}`, `/api/searches/${search.id}/export`]) {
        const malformed = await app.inject({ url, cookies });
        assert.equal(malformed.statusCode, 400);
        assert.deepEqual(Object.keys(malformed.json()), ['error', 'requestId']);
      }
      await database.pool.query(
        `UPDATE saved_leads SET data = data || '{"unexpectedField": "should never reach a client"}'::jsonb WHERE id = $1`,
        [savedLead!.id],
      );
      const strippedLead = await app.inject({ url: `/api/leads/${savedLead!.id}`, cookies });
      assert.equal(strippedLead.statusCode, 200);
      assert.ok(!JSON.stringify(strippedLead.json()).includes('unexpectedField'));
      await database.pool.query(`UPDATE saved_leads SET data = data - 'title' WHERE id = $1`, [
        savedLead!.id,
      ]);
      const malformedLead = await app.inject({ url: `/api/leads/${savedLead!.id}`, cookies });
      assert.equal(malformedLead.statusCode, 400);
      assert.deepEqual(Object.keys(malformedLead.json()), ['error', 'requestId']);
      // Restore both rows to their real, valid shape so nothing downstream
      // of this point (list/history assertions elsewhere, if any were to be
      // added later) inherits a deliberately-corrupted fixture.
      await database.pool.query(
        `UPDATE search_jobs SET data = (data - 'unexpectedField') || $2::jsonb WHERE id = $1`,
        [jobId, JSON.stringify({ title: detail.json().jobs[0].data.title })],
      );
      await database.pool.query(
        `UPDATE saved_leads SET data = (data - 'unexpectedField') || $2::jsonb WHERE id = $1`,
        [savedLead!.id, JSON.stringify({ title: savedLead!.data.title })],
      );

      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const eventUrl = `${address}/api/searches/${search.id}/events`;
      const eventHeaders = { cookie: `${sessionCookie.name}=${sessionCookie.value}` };
      const stream = await fetch(eventUrl, {
        headers: eventHeaders,
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(stream.status, 200);
      assert.match(stream.headers.get('content-type')!, /^text\/event-stream/);
      assert.equal(stream.headers.get('x-accel-buffering'), 'no');
      const replay = await stream.text();
      assert.match(replay, /SearchQueued/);
      assert.match(replay, /SearchPartial/);
      assert.match(replay, /event: settled/);
      assert.doesNotMatch(replay, /Validated partial result|example\.test|sourceOutcomes/);
      const queuedCursor = detail.json().events[0].cursor;
      const terminalCursor = detail.json().events.at(-1).cursor;
      const resumed = await fetch(`${eventUrl}?after=0`, {
        headers: { ...eventHeaders, 'Last-Event-ID': queuedCursor },
        signal: AbortSignal.timeout(5000),
      });
      const resumedText = await resumed.text();
      assert.doesNotMatch(resumedText, /SearchQueued/);
      assert.match(resumedText, /SearchPartial/);
      const caughtUp = await fetch(`${eventUrl}?after=${terminalCursor}`, {
        headers: eventHeaders,
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(await caughtUp.text(), 'retry: 2000\n\nevent: settled\ndata: {}\n\n');
      for (const invalid of ['-1', '9223372036854775808', '99999999', '1e2']) {
        assert.equal(
          (await app.inject({ url: `/api/searches/${search.id}/events?after=${invalid}`, cookies }))
            .statusCode,
          400,
        );
      }
      // A cursor older than the retained window must resynchronise, not fail.
      await database.pool.query(
        'DELETE FROM run_events WHERE owner_id = $1 AND run_id = $2 AND sequence = $3::bigint',
        [ownerId, search.id, queuedCursor],
      );
      const expired = await fetch(`${eventUrl}?after=${queuedCursor}`, {
        headers: eventHeaders,
        signal: AbortSignal.timeout(5000),
      });
      const expiredText = await expired.text();
      assert.equal(expired.status, 200);
      assert.match(expiredText, /event: reset\ndata: \{"reason":"cursor-expired"\}/);
      assert.match(expiredText, /SearchPartial/);
      assert.equal(
        (
          await app.inject({
            url: `/api/searches/${search.id}/events`,
            cookies: { [sessionCookie.name]: otherToken },
          })
        ).statusCode,
        404,
      );
      assert.equal((await app.inject(`/api/searches/${search.id}/events`)).statusCode, 401);
      const live = await database.createSearch(ownerId, 'live-stream-revocation', request);
      const liveUrl = `${address}/api/searches/${live.id}/events`;
      const concurrentStreams = await Promise.all(
        Array.from({ length: 3 }, () =>
          fetch(liveUrl, { headers: eventHeaders, signal: AbortSignal.timeout(5000) }),
        ),
      );
      assert.deepEqual(
        concurrentStreams.map((response) => response.status).sort(),
        [200, 200, 429],
      );
      const liveStreams = concurrentStreams.filter((response) => response.status === 200);
      await concurrentStreams.find((response) => response.status === 429)!.text();
      assert.ok(liveStreams.every((response) => response.status === 200));
      const denied = await fetch(liveUrl, {
        headers: eventHeaders,
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(denied.status, 429);
      await denied.text();
      await new Auth(database).logout(sessionCookie.value);
      for (const response of liveStreams)
        assert.match(await response.text(), /event: session-expired/);
    } finally {
      await app.close();
    }
    const failed = await database.createSearch(ownerId, 'all-failed-result', request);
    const failedCommand = (await database.unpublished()).find(
      (entry) => entry.command.aggregateId === failed.id,
    )!.command;
    const failedFence = await database.claim(failedCommand.id);
    assert.ok(failedFence);
    const failedOutcomes: SourceOutcome[] = outcomes.map((outcome) => ({
      ...outcome,
      status: 'failed',
      accepted: 0,
      errorCode: 'source_failed',
    }));
    assert.equal(
      await database.completeCollection(failedCommand, failedFence, [], failedOutcomes),
      true,
    );
    assert.equal((await database.getSearch(ownerId, failed.id))?.status, 'failed');
    assert.equal(await database.executionStatus(failedCommand.id), 'completed');
    const cancelled = await database.createSearch(ownerId, 'partial-cancelled', request);
    const cancelledCommand = (await database.unpublished()).find(
      (entry) => entry.command.aggregateId === cancelled.id,
    )!.command;
    const cancelledFence = await database.claim(cancelledCommand.id);
    assert.ok(cancelledFence);
    await database.cancelSearch(ownerId, cancelled.id);
    assert.equal(
      await database.completeCollection(cancelledCommand, cancelledFence, [job], outcomes),
      false,
    );
    assert.equal((await database.getSearch(ownerId, cancelled.id))?.sourceOutcomes, null);
    const handler = searchHandler(database, [
      {
        ...createRemoteOkProvider(),
        async *search() {
          yield {
            source: 'remoteok' as const,
            sourceJobId: 'queue-partial',
            title: job.title,
            companyName: job.company,
            location: job.location,
            description: job.description,
            sourceUrl: job.sourceUrl,
            applyUrl: job.applyUrl,
            // REQUIRED by RawJob and it was missing, so this synthetic job was
            // not a RawJob at all — invisible until v2 test files were first
            // type-checked. It is not inert: `collect.ts` uses it to decide
            // whether to fetch detail, `normalize.ts` folds it into the
            // description and into dedup ranking, and a missing value read as
            // `undefined`, i.e. falsy.
            //
            // `false` is deliberate, not a placeholder. It reproduces exactly
            // the branch this test has always taken; `true` would change what
            // the test exercises under cover of a type fix. If a full
            // description was ever intended here, that is a separate,
            // deliberate change — asserted below to make no difference to this
            // test's subject either way.
            hasFullDescription: false,
          };
        },
      },
      {
        ...createHimalayasProvider(),
        async *search() {
          yield* [];
          throw new Error('Synthetic provider outage; must not reach events');
        },
      },
    ]);
    const queue = new LocalQueue(process.env.LOCAL_AWS_ENDPOINT!);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const racing = await database.createSearch(ownerId, `event-order-${attempt}`, request);
      const racingCommand = (await database.unpublished()).find(
        (entry) => entry.command.aggregateId === racing.id,
      )!.command;
      const racingFence = await database.claim(racingCommand.id);
      assert.ok(racingFence);
      await Promise.all([
        database.startSearch(racingCommand, racingFence),
        database.completeCollection(racingCommand, racingFence, [job], outcomes),
      ]);
      const ordered = await database.pool.query(
        'SELECT type FROM run_events WHERE owner_id = $1 AND run_id = $2 ORDER BY sequence',
        [ownerId, racing.id],
      );
      assert.equal(ordered.rows[0].type, 'SearchQueued');
      assert.equal(ordered.rows.at(-1).type, 'SearchPartial');
      assert.ok(ordered.rowCount === 2 || ordered.rowCount === 3);
      if (ordered.rowCount === 3) assert.equal(ordered.rows[1].type, 'SearchStarted');
    }
    try {
      await queue.initialize(`test-partial-${randomUUID()}`);
      for (const [transport, allFailed] of [
        ['sqs', false],
        ['bullmq', false],
        ['sqs', true],
        ['bullmq', true],
      ] as const) {
        const execute = allFailed
          ? searchHandler(
              database,
              [createRemoteOkProvider(), createHimalayasProvider()].map((provider) => ({
                ...provider,
                async *search() {
                  yield* [];
                  throw new Error('Synthetic total source outage');
                },
              })),
            )
          : handler;
        const queued = await database.createSearch(
          ownerId,
          `partial-${transport}-${allFailed}`,
          request,
        );
        const queuedCommand = (await database.unpublished()).find(
          (entry) => entry.command.aggregateId === queued.id,
        )!.command;
        if (transport === 'sqs') {
          await queue.send(queuedCommand);
          const message = await queue.receive(undefined, 1);
          assert.ok(message);
          assert.equal(
            await consumeMessage(
              database,
              queue,
              message,
              'search.collect',
              execute,
              new AbortController().signal,
            ),
            'completed',
          );
        } else {
          assert.equal(
            await executeBullCommand(
              database,
              queuedCommand,
              execute,
              new AbortController().signal,
            ),
            'completed',
          );
        }
        const result = await database.getSearch(ownerId, queued.id);
        assert.equal(result?.status, allFailed ? 'failed' : 'partial');
        assert.deepEqual(result?.sourceOutcomes, allFailed ? failedOutcomes : outcomes);
        assert.equal(await database.executionStatus(queuedCommand.id), 'completed');
        assert.equal(
          await executeBullCommand(database, queuedCommand, execute, new AbortController().signal),
          'duplicate',
        );
      }
    } finally {
      for (const url of [queue.url, queue.deadLetterUrl].filter(Boolean))
        await queue.client.send(new DeleteQueueCommand({ QueueUrl: url }));
      queue.close();
    }
  } finally {
    await rm(previousMigrations, { recursive: true, force: true });
    await database.close();
    await admin.pool.query(`DROP DATABASE "${name}"`);
    await admin.close();
  }
});

test('PostgreSQL atomic outbox, owner isolation and stale-worker fencing', async () => {
  const configured = process.env.DATABASE_URL;
  assert.ok(configured, 'Integration tests require the isolated v2 DATABASE_URL');
  const base = new URL(configured);
  assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname), 'Tests require local PostgreSQL');
  const admin = new Database(configured);
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  base.pathname = `/${name}`;
  const database = new Database(base.href);
  try {
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL('../../../migrations', import.meta.url)),
    });
    const ownerId = randomUUID();
    await database.db.insert(users).values({
      id: ownerId,
      email: `${ownerId}@example.test`,
      passwordHash: 'synthetic-not-a-login',
    });
    const request = { query: 'React', sources: ['remoteok'] as ['remoteok'] };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => database.createSearch(ownerId, 'same-key', request)),
    );
    assert.equal(new Set(results.map((result) => result.id)).size, 1);
    assert.equal((await database.unpublished()).length, 1);
    await assert.rejects(
      database.createSearch(ownerId, 'same-key', { ...request, query: 'Python' }),
      Conflict,
    );
    assert.equal(await database.getSearch(randomUUID(), results[0]!.id), undefined);
    const record = (await database.unpublished())[0]!;
    const { command } = record;
    assert.equal(await database.claim(randomUUID()), null);
    const claims = await Promise.all(Array.from({ length: 8 }, () => database.claim(command.id)));
    assert.equal(claims.filter((value) => value !== null).length, 1);
    assert.equal(await database.complete({ ...command, ownerId: randomUUID() }, 1), false);
    assert.equal(await database.renew(command.id, 99), false);
    assert.equal(await database.renew(command.id, 1), true);
    await database.pool.query(
      "UPDATE command_executions SET lease_until = now() - interval '1 second' WHERE id = $1",
      [command.id],
    );
    const newFence = await database.claim(command.id);
    assert.equal(newFence, 2);
    assert.equal(await database.renew(command.id, 1), false);
    assert.equal(await database.complete(command, 1), false);
    assert.equal(await database.complete(command, newFence!), true);
    assert.equal(await database.claim(command.id), null);
    assert.equal(await database.complete(command, newFence!), false);
    assert.equal((await database.getSearch(ownerId, command.aggregateId))?.status, 'completed');
    assert.equal(
      (await database.pool.query("SELECT * FROM run_events WHERE type = 'SearchCompleted'"))
        .rowCount,
      1,
    );
    await assert.rejects(database.createSearch(randomUUID(), 'invalid-owner', request));
    assert.equal((await database.unpublished()).length, 1);
    const queue = new LocalQueue(process.env.LOCAL_AWS_ENDPOINT!);
    try {
      await queue.initialize(`test-${randomUUID()}`);
      await queue.send(command);
      assert.equal(await publishPending(database, { 'search.collect': queue }), 1);
      assert.equal(await publishPending(database, { 'search.collect': queue }), 0);
      const shutdown = new AbortController();
      const unexpectedHandler = async () => {
        throw new Error('Completed command must not execute again');
      };
      for (let delivery = 0; delivery < 2; delivery += 1) {
        const duplicate = await queue.receive(undefined, 1);
        assert.ok(duplicate);
        assert.equal(
          await consumeMessage(
            database,
            queue,
            duplicate,
            'search.collect',
            unexpectedHandler,
            shutdown.signal,
          ),
          'duplicate',
        );
      }
      const pending = await database.createSearch(ownerId, 'worker-test', request);
      const queuedBacklog = await database.backlog();
      assert.equal(queuedBacklog.unpublished, 1);
      assert.ok((queuedBacklog.oldestUnpublishedSeconds ?? -1) >= 0);
      assert.equal(await publishPending(database, { 'search.collect': queue }), 1);
      assert.equal((await database.backlog()).unpublished, 0);
      const next = await queue.receive(undefined, 1);
      assert.ok(next?.ReceiptHandle);
      await assert.rejects(
        consumeMessage(
          database,
          queue,
          next,
          'search.collect',
          async () => {
            throw new Error('Synthetic provider unavailable');
          },
          shutdown.signal,
        ),
        /Synthetic provider unavailable/,
      );
      assert.equal((await database.getSearch(ownerId, pending.id))?.status, 'queued');
      assert.ok((await database.backlog()).running >= 1);
      await queue.visibility(next.ReceiptHandle, 0);
      const retry = await queue.receive(undefined, 1);
      assert.ok(retry);
      const job = {
        fingerprint: 'synthetic-job',
        sourceJobId: 'synthetic-job',
        title: 'React engineer',
        company: 'Example',
        location: 'Remote',
        description: 'Synthetic integration fixture',
        source: 'remoteok' as const,
        sourceUrl: 'https://remoteok.com/remote-jobs/synthetic',
        applyUrl: 'https://example.test/apply',
        postedAt: null,
      };
      assert.equal(
        await consumeMessage(
          database,
          queue,
          retry,
          'search.collect',
          (retryCommand, retryFence) => database.complete(retryCommand, retryFence, [job, job]),
          shutdown.signal,
        ),
        'completed',
      );
      assert.equal((await database.getSearch(ownerId, pending.id))?.status, 'completed');
      assert.equal(
        (await database.pool.query('SELECT * FROM search_jobs WHERE run_id = $1', [pending.id]))
          .rowCount,
        1,
      );
      await assert.rejects(
        consumeMessage(
          database,
          queue,
          {
            ...retry,
            Body: JSON.stringify({ ...JSON.parse(retry.Body!), ownerId: randomUUID() }),
          },
          'search.collect',
          unexpectedHandler,
          shutdown.signal,
        ),
        /does not match/,
      );
      const exhausted = await database.createSearch(ownerId, 'exhausted-retries', request);
      const exhaustedCommand = (await database.unpublished())[0]!.command;
      await publishPending(database, { 'search.collect': queue });
      await database.pool.query(
        `INSERT INTO command_executions (id, status, fence, attempts, lease_until)
        VALUES ($1, 'running', 4, 4, now() - interval '1 second')`,
        [exhaustedCommand.id],
      );
      const lastTry = await queue.receive(undefined, 1);
      assert.ok(lastTry?.ReceiptHandle);
      await assert.rejects(
        consumeMessage(
          database,
          queue,
          lastTry,
          'search.collect',
          unexpectedHandler,
          shutdown.signal,
        ),
      );
      assert.equal((await database.getSearch(ownerId, exhausted.id))?.status, 'failed');
      assert.equal(await database.claim(exhaustedCommand.id), null);
      const abandoned = await database.createSearch(ownerId, 'abandoned-queue', request);
      const abandonedCommand = (await database.unpublished())[0]!.command;
      await database.published(abandonedCommand.id);
      await database.pool.query(
        "UPDATE outbox_events SET published_at = now() - interval '3 minutes' WHERE id = $1",
        [abandonedCommand.id],
      );
      assert.equal((await database.unpublished())[0]!.command.id, abandonedCommand.id);
      assert.equal(
        await reconcileDeadLetter(database, { Body: JSON.stringify(abandonedCommand) }),
        true,
      );
      assert.equal((await database.getSearch(ownerId, abandoned.id))?.status, 'failed');
      assert.equal((await database.unpublished()).length, 0);
      assert.equal(
        await reconcileDeadLetter(database, { Body: JSON.stringify(abandonedCommand) }),
        false,
      );
    } finally {
      for (const url of [queue.url, queue.deadLetterUrl].filter(Boolean)) {
        await queue.client.send(new DeleteQueueCommand({ QueueUrl: url }));
      }
      queue.close();
    }
    for (const active of [false, true]) {
      const cancellable = await database.createSearch(ownerId, `cancel-${active}`, request);
      const cancellationCommand = (await database.unpublished()).find(
        (entry) => entry.command.aggregateId === cancellable.id,
      )!.command;
      const fence = active ? await database.claim(cancellationCommand.id) : null;
      assert.equal(await database.cancelSearch(randomUUID(), cancellable.id), undefined);
      const cancellations = await Promise.all(
        Array.from({ length: 4 }, () => database.cancelSearch(ownerId, cancellable.id)),
      );
      assert.ok(cancellations.every((search) => search?.status === 'cancelled'));
      assert.equal(await database.claim(cancellationCommand.id), null);
      if (fence !== null) {
        assert.equal(await database.renew(cancellationCommand.id, fence), false);
        assert.equal(await database.complete(cancellationCommand, fence), false);
        assert.equal(await database.fail(cancellationCommand, fence), false);
      }
      const terminal = await database.pool.query(
        "SELECT type FROM run_events WHERE run_id = $1 AND type <> 'SearchQueued'",
        [cancellable.id],
      );
      assert.deepEqual(terminal.rows, [{ type: 'SearchCancelled' }]);
      const neverRun = async () => {
        throw new Error('Cancelled work must not run');
      };
      assert.equal(
        await executeBullCommand(
          database,
          cancellationCommand,
          neverRun,
          new AbortController().signal,
        ),
        'duplicate',
      );
      const cancelledQueue = new LocalQueue(process.env.LOCAL_AWS_ENDPOINT!);
      try {
        await cancelledQueue.initialize(`test-cancel-${randomUUID()}`);
        await cancelledQueue.send(cancellationCommand);
        const message = await cancelledQueue.receive(undefined, 1);
        assert.ok(message);
        assert.equal(
          await consumeMessage(
            database,
            cancelledQueue,
            message,
            'search.collect',
            neverRun,
            new AbortController().signal,
          ),
          'duplicate',
        );
      } finally {
        for (const url of [cancelledQueue.url, cancelledQueue.deadLetterUrl].filter(Boolean)) {
          await cancelledQueue.client.send(new DeleteQueueCommand({ QueueUrl: url }));
        }
        cancelledQueue.close();
      }
    }
    assert.equal((await database.cancelSearch(ownerId, command.aggregateId))?.status, 'completed');
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const racing = await database.createSearch(ownerId, `cancel-race-${attempt}`, request);
      const racingCommand = (await database.unpublished()).find(
        (entry) => entry.command.aggregateId === racing.id,
      )!.command;
      const fence = await database.claim(racingCommand.id);
      await Promise.all([
        database.complete(racingCommand, fence!),
        database.cancelSearch(ownerId, racing.id),
      ]);
      const terminal = await database.pool.query(
        "SELECT type FROM run_events WHERE run_id = $1 AND type <> 'SearchQueued'",
        [racing.id],
      );
      assert.equal(terminal.rowCount, 1);
      const state = await database.getSearch(ownerId, racing.id);
      assert.equal(
        terminal.rows[0].type,
        state?.status === 'completed' ? 'SearchCompleted' : 'SearchCancelled',
      );
    }
    await assert.rejects(
      new Auth(database).createOwner('replacement@example.test', randomUUID()),
      /already configured/,
    );
    assert.equal(new Auth(database).validCsrf('a'.repeat(64), '\u00e9'.repeat(64)), false);
    const password = randomUUID();
    await database.pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [
      await passwordHash(password),
      ownerId,
    ]);
    let allowRequest = true;
    const origin = 'http://localhost:5280';
    const app = await createApp(database, origin, async () => allowRequest);
    try {
      assert.equal((await app.inject('/api/searches')).statusCode, 401);
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/login',
            payload: { email: `${ownerId}@example.test`, password },
          })
        ).statusCode,
        403,
      );
      const login = await app.inject({
        method: 'POST',
        url: '/api/login',
        headers: { origin },
        payload: { email: `${ownerId}@example.test`, password },
      });
      assert.equal(login.statusCode, 200);
      const cookieValue = login.cookies[0]!;
      assert.equal(cookieValue.httpOnly, true);
      const cookies = { [cookieValue.name]: cookieValue.value };
      const session = (await app.inject({ url: '/api/session', cookies })).json();
      const headers = { origin, 'x-csrf-token': session.csrf, 'idempotency-key': 'api-regression' };
      assert.equal((await app.inject('/api/profile')).statusCode, 401);
      const emptyProfile = await app.inject({ url: '/api/profile', cookies });
      assert.deepEqual(emptyProfile.json(), {
        revision: 0,
        profile: null,
        updatedAt: null,
        scheduledDiscoveryEnabled: false,
      });
      assert.equal(emptyProfile.headers['cache-control'], 'no-store');
      assert.equal((await app.inject('/api/preparation')).statusCode, 401);
      assert.equal(
        (await app.inject({ url: '/api/preparation', cookies })).json().status,
        'profile-required',
      );
      const profile = {
        candidate: {
          fullName: 'Example Candidate',
          email: 'candidate@example.test',
          location: 'Hyderabad',
        },
        preferences: { titles: ['React Engineer'], techStack: ['React', 'TypeScript'] },
        application: { yearsOfExperience: 4 },
      };
      assert.equal(
        (
          await app.inject({
            method: 'PUT',
            url: '/api/profile',
            cookies,
            headers: { origin },
            payload: { revision: 0, profile },
          })
        ).statusCode,
        403,
      );
      const competingSaves = await Promise.all(
        Array.from({ length: 2 }, () =>
          app.inject({
            method: 'PUT',
            url: '/api/profile',
            cookies,
            headers,
            payload: { revision: 0, profile },
          }),
        ),
      );
      assert.deepEqual(competingSaves.map((response) => response.statusCode).sort(), [200, 409]);
      assert.equal((await app.inject({ url: '/api/profile', cookies })).json().revision, 1);
      const updatedProfile = await app.inject({
        method: 'PUT',
        url: '/api/profile',
        cookies,
        headers,
        payload: { revision: 1, profile: { ...profile, application: { yearsOfExperience: 5 } } },
      });
      assert.equal(updatedProfile.statusCode, 200);
      assert.equal(updatedProfile.json().revision, 2);
      assert.equal(
        (
          await app.inject({
            method: 'PUT',
            url: '/api/profile',
            cookies,
            headers,
            payload: { revision: 1, profile },
          })
        ).statusCode,
        409,
      );
      assert.equal(
        (
          await app.inject({
            method: 'PUT',
            url: '/api/profile',
            cookies,
            headers,
            payload: { revision: 2, ownerId: randomUUID(), profile },
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await app.inject({
            method: 'PUT',
            url: '/api/profile',
            cookies,
            headers,
            payload: {
              revision: 2,
              profile: { ...profile, application: { yearsOfExperience: -1 } },
            },
          })
        ).statusCode,
        400,
      );
      const otherOwner = randomUUID();
      const otherEmail = `${otherOwner}@example.test`;
      await database.db
        .insert(users)
        .values({ id: otherOwner, email: otherEmail, passwordHash: await passwordHash(password) });
      const otherToken = await new Auth(database).login(otherEmail, password);
      assert.ok(otherToken);
      assert.equal(
        (
          await app.inject({ url: '/api/profile', cookies: { [cookieValue.name]: otherToken } })
        ).json().profile,
        null,
      );
      const persistedProfile = (await app.inject({ url: '/api/profile', cookies })).json();
      assert.equal(persistedProfile.profile.application.yearsOfExperience, 5);
      assert.equal(persistedProfile.revision, 2);
      const preparation = await app.inject({ url: '/api/preparation', cookies });
      assert.equal(preparation.statusCode, 200);
      assert.equal(preparation.headers['cache-control'], 'no-store');
      assert.equal(preparation.json().profileRevision, 2);
      assert.equal(preparation.json().method, 'rules-v1');
      assert.ok(!preparation.body.includes(profile.candidate.email));
      assert.equal(
        (
          await app.inject({ url: '/api/preparation', cookies: { [cookieValue.name]: otherToken } })
        ).json().status,
        'profile-required',
      );
      assert.equal(
        (await app.inject({ url: `/api/preparation?ownerId=${otherOwner}`, cookies })).statusCode,
        400,
      );
      allowRequest = false;
      assert.equal((await app.inject({ url: '/api/preparation', cookies })).statusCode, 429);
      allowRequest = true;
      assert.deepEqual(
        (await app.inject({ url: '/api/profile', cookies })).json(),
        persistedProfile,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/searches',
            cookies,
            headers: { origin },
            payload: request,
          })
        ).statusCode,
        403,
      );
      const created = await app.inject({
        method: 'POST',
        url: '/api/searches',
        cookies,
        headers,
        payload: request,
      });
      assert.equal(created.statusCode, 202);
      const pendingExportUrl = `/api/searches/${created.json().runId}/export`;
      assert.equal((await app.inject({ url: pendingExportUrl, cookies })).statusCode, 409);
      const exportUrl = `/api/searches/${command.aggregateId}/export`;
      assert.equal((await app.inject(exportUrl)).statusCode, 401);
      assert.equal(
        (await app.inject({ url: exportUrl, cookies: { [cookieValue.name]: otherToken } }))
          .statusCode,
        404,
      );
      assert.equal(
        (await app.inject({ url: '/api/searches/invalid/export', cookies })).statusCode,
        400,
      );
      assert.equal(
        (await app.inject({ url: `/api/searches/${randomUUID()}/export`, cookies })).statusCode,
        404,
      );
      const emptyExport = await app.inject({ url: exportUrl, cookies });
      assert.equal(emptyExport.statusCode, 200);
      assert.deepEqual(emptyExport.json(), {
        schemaVersion: 1,
        runId: command.aggregateId,
        status: 'completed',
        sourceOutcomes: null,
        // CS-26: the export route re-parses the stored request through the
        // current createSearchSchema (app.ts), so a historical row saved
        // before `origin` existed still comes back with the schema's
        // default applied - this is the export endpoint's own existing,
        // intentional normalization behavior, not something CS-26 changed.
        request: { ...request, origin: 'manual' },
        jobs: [],
      });
      assert.equal(emptyExport.headers['cache-control'], 'no-store');
      assert.equal(
        emptyExport.headers['content-disposition'],
        `attachment; filename="careerscope-search-${command.aggregateId}.json"`,
      );
      assert.match(String(emptyExport.headers['content-type']), /^application\/json/);
      const populatedRun = await database.createSearch(ownerId, 'export-fixture', request);
      const populatedCommand = (await database.unpublished()).find(
        (entry) => entry.command.aggregateId === populatedRun.id,
      )!.command;
      const populatedFence = await database.claim(populatedCommand.id);
      assert.ok(populatedFence);
      await database.complete(populatedCommand, populatedFence, [
        {
          fingerprint: 'export-synthetic',
          sourceJobId: 'export-synthetic',
          title: '=Synthetic "React" Engineer',
          company: 'Example',
          location: 'Remote',
          description: 'First line\nSecond line <script>untrusted</script>',
          source: 'himalayas',
          sourceUrl: 'https://himalayas.app/jobs/synthetic',
          applyUrl: 'https://example.test/apply',
          postedAt: null,
        },
      ]);
      await database.pool.query(
        'UPDATE search_jobs SET data = data || $1::jsonb WHERE run_id = $2',
        [JSON.stringify({ privateNotes: 'must-not-export' }), populatedRun.id],
      );
      const populatedExport = await app.inject({
        url: `/api/searches/${populatedRun.id}/export`,
        cookies,
      });
      assert.equal(populatedExport.statusCode, 200);
      assert.equal(populatedExport.json().jobs.length, 1);
      assert.equal(populatedExport.json().jobs[0].title, '=Synthetic "React" Engineer');
      assert.equal(
        populatedExport.json().jobs[0].description,
        'First line\nSecond line <script>untrusted</script>',
      );
      assert.equal(populatedExport.json().jobs[0].source, 'himalayas');
      assert.equal(populatedExport.json().jobs[0].match, null);
      assert.doesNotMatch(
        populatedExport.body,
        /must-not-export|candidate@example.test|passwordHash|matchingProfile|ownerId/,
      );
      const snapshot = await database.getSearch(ownerId, created.json().runId);
      const jobId = (
        await database.pool.query('SELECT id FROM search_jobs WHERE run_id = $1', [populatedRun.id])
      ).rows[0].id;
      assert.equal((await app.inject('/api/leads')).statusCode, 401);
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/leads',
            cookies,
            headers: { origin },
            payload: { jobId },
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/leads',
            cookies,
            headers,
            payload: { jobId, ownerId: otherOwner },
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/leads',
            cookies,
            headers,
            payload: { jobId: randomUUID() },
          })
        ).statusCode,
        404,
      );
      const leadRepository = new LeadRepository(database);
      assert.equal(await leadRepository.save(otherOwner, { jobId }), null);
      const saves = await Promise.all(
        Array.from({ length: 6 }, () =>
          app.inject({ method: 'POST', url: '/api/leads', cookies, headers, payload: { jobId } }),
        ),
      );
      assert.ok(saves.every((response) => response.statusCode === 200));
      assert.equal(new Set(saves.map((response) => response.json().id)).size, 1);
      const lead = saves[0]!.json();
      const leadUrl = `/api/leads/${lead.id}`;
      const hydrated = await app.inject({ url: `/api/leads/by-job/${jobId}`, cookies });
      assert.equal(hydrated.statusCode, 200);
      assert.equal(hydrated.json().lead.id, lead.id);
      assert.equal(
        (
          await app.inject({
            url: `/api/leads/by-job/${jobId}`,
            cookies: { [cookieValue.name]: otherToken },
          })
        ).json().lead,
        null,
      );
      assert.equal(
        (await app.inject({ url: `/api/leads/by-job/${randomUUID()}`, cookies })).json().lead,
        null,
      );
      assert.equal(
        (await app.inject({ url: '/api/leads/by-job/not-a-uuid', cookies })).statusCode,
        400,
      );
      assert.equal(lead.revision, 1);
      assert.equal(lead.status, 'saved');
      assert.doesNotMatch(saves[0]!.body, /must-not-export/);
      for (const suffix of ['', '/history']) {
        assert.equal(
          (await app.inject({ url: leadUrl + suffix, cookies: { [cookieValue.name]: otherToken } }))
            .statusCode,
          404,
        );
      }
      assert.equal(
        (
          await app.inject({ url: '/api/leads', cookies: { [cookieValue.name]: otherToken } })
        ).json().items.length,
        0,
      );
      assert.equal(
        (
          await app.inject({
            method: 'PUT',
            url: leadUrl,
            cookies: { [cookieValue.name]: otherToken },
            headers: {
              origin,
              'x-csrf-token': (
                await app.inject({
                  url: '/api/session',
                  cookies: { [cookieValue.name]: otherToken },
                })
              ).json().csrf,
            },
            payload: { revision: 1, notes: 'not mine', status: 'saved' },
          })
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await app.inject({
            method: 'PUT',
            url: leadUrl,
            cookies,
            headers: { origin },
            payload: { revision: 1, notes: '', status: 'saved' },
          })
        ).statusCode,
        403,
      );
      for (const invalid of [
        // 'applied' became a real pipeline stage; 'hired' is still not one, so
        // this keeps asserting that an unknown status is refused.
        { revision: 1, notes: '', status: 'hired' },
        { revision: 0, notes: '', status: 'saved' },
        { revision: 1, notes: 'x'.repeat(10001), status: 'saved' },
        { revision: 1, notes: '', status: 'saved', ownerId },
      ])
        assert.equal(
          (await app.inject({ method: 'PUT', url: leadUrl, cookies, headers, payload: invalid }))
            .statusCode,
          400,
        );
      const updates = await Promise.all(
        Array.from({ length: 2 }, (_, index) =>
          app.inject({
            method: 'PUT',
            url: leadUrl,
            cookies,
            headers,
            payload: { revision: 1, notes: `Private note ${index}`, status: 'saved' },
          }),
        ),
      );
      assert.deepEqual(updates.map((response) => response.statusCode).sort(), [200, 409]);
      const revised = updates.find((response) => response.statusCode === 200)!.json();
      const archived = await app.inject({
        method: 'PUT',
        url: leadUrl,
        cookies,
        headers,
        payload: { revision: revised.revision, notes: revised.notes, status: 'archived' },
      });
      assert.equal(archived.statusCode, 200);
      assert.equal((await app.inject({ url: '/api/leads', cookies })).json().items.length, 0);
      assert.equal(
        (await app.inject({ url: '/api/leads?status=archived', cookies })).json().items[0].id,
        lead.id,
      );
      const duplicate = (
        await app.inject({
          method: 'POST',
          url: '/api/leads',
          cookies,
          headers,
          payload: { jobId },
        })
      ).json();
      assert.equal(duplicate.status, 'archived');
      assert.equal(duplicate.notes, revised.notes);
      assert.equal(duplicate.revision, 3);
      const restored = await app.inject({
        method: 'PUT',
        url: leadUrl,
        cookies,
        headers,
        payload: { revision: 3, notes: revised.notes, status: 'saved' },
      });
      assert.equal(restored.json().revision, 4);
      const noop = await app.inject({
        method: 'PUT',
        url: leadUrl,
        cookies,
        headers,
        payload: { revision: 4, notes: revised.notes, status: 'saved' },
      });
      assert.equal(noop.json().revision, 4);
      const audit = await app.inject({ url: `${leadUrl}/history`, cookies });
      assert.deepEqual(
        audit.json().items.map((entry: { revision: number }) => entry.revision),
        [4, 3, 2, 1],
      );
      assert.deepEqual(
        audit.json().items.map((entry: { notesChanged: boolean }) => entry.notesChanged),
        [false, false, true, false],
      );
      assert.doesNotMatch(audit.body, /Private note/);
      assert.equal(audit.headers['cache-control'], 'no-store');
      assert.equal((await app.inject({ url: '/api/leads?limit=51', cookies })).statusCode, 400);
      assert.equal(
        // Same reason as above: 'applied' is now a real stage, 'hired' is not.
        (await app.inject({ url: '/api/leads?status=hired', cookies })).statusCode,
        400,
      );
      assert.equal(
        (await app.inject({ url: `${leadUrl}/history?before=invalid`, cookies })).statusCode,
        400,
      );
      assert.equal(
        (await app.inject({ url: `${leadUrl}/history?before=3`, cookies })).json().items.length,
        2,
      );
      for (let revision = 4; revision < 30; revision += 1) {
        await leadRepository.update(ownerId, lead.id, {
          revision,
          status: 'saved',
          notes: `History fixture ${revision}`,
        });
      }
      const firstHistory = await leadRepository.history(ownerId, lead.id, {});
      assert.equal(firstHistory?.items.length, 25);
      assert.equal(firstHistory?.nextCursor, 6);
      assert.equal(
        (await leadRepository.history(ownerId, lead.id, { before: firstHistory?.nextCursor }))
          ?.items.length,
        5,
      );
      const secondJob = (
        await database.pool.query(
          'SELECT id FROM search_jobs WHERE owner_id = $1 AND run_id <> $2 LIMIT 1',
          [ownerId, populatedRun.id],
        )
      ).rows[0].id;
      const secondLead = await leadRepository.save(ownerId, { jobId: secondJob });
      assert.ok(secondLead);
      await database.pool.query('UPDATE saved_leads SET created_at = $1 WHERE owner_id = $2', [
        '2026-09-14T00:00:00.123456Z',
        ownerId,
      ]);
      const firstPage = await leadRepository.list(ownerId, { limit: 1 });
      assert.ok(firstPage.nextCursor);
      const secondPage = await leadRepository.list(ownerId, {
        limit: 1,
        before: firstPage.nextCursor,
      });
      assert.equal(secondPage.items.length, 1);
      assert.notEqual(firstPage.items[0]!.id, secondPage.items[0]!.id);
      assert.equal(secondPage.nextCursor, null);
      await assert.rejects(
        database.pool.query(
          "INSERT INTO lead_history (id, owner_id, lead_id, revision, status, notes_changed) VALUES ($1, $2, $3, 100, 'saved', 0)",
          [randomUUID(), otherOwner, lead.id],
        ),
      );
      await assert.rejects(
        // The database, not just the API, refuses a status outside the pipeline.
        // 'applied' is now a real stage, so 'hired' carries the original intent.
        database.pool.query("UPDATE saved_leads SET status = 'hired' WHERE id = $1", [lead.id]),
      );
      assert.equal(snapshot?.profileRevision, 2);
      assert.equal(snapshot?.matchingProfile?.application.yearsOfExperience, 5);
      assert.deepEqual(Object.keys(snapshot!.matchingProfile!.candidate), ['location']);
      const profileRequest = { ...request, useProfileTitles: true };
      const profileDiscovery = await database.createSearch(
        ownerId,
        'saved-role-discovery',
        profileRequest,
      );
      assert.equal(profileDiscovery.request.useProfileTitles, true);
      assert.equal(profileDiscovery.profileRevision, 2);
      assert.deepEqual(
        profileDiscovery.matchingProfile?.preferences.titles,
        profile.preferences.titles,
      );
      assert.equal(await database.getSearch(otherOwner, profileDiscovery.id), undefined);
      const beforeRejected = (
        await database.pool.query('SELECT count(*)::int AS count FROM outbox_events')
      ).rows[0].count;
      await assert.rejects(
        database.createSearch(otherOwner, 'missing-profile-discovery', profileRequest),
        Conflict,
      );
      assert.equal(
        (await database.pool.query('SELECT count(*)::int AS count FROM outbox_events')).rows[0]
          .count,
        beforeRejected,
      );
      assert.equal(
        (
          await app.inject({
            method: 'PUT',
            url: '/api/profile',
            cookies,
            headers,
            payload: {
              revision: 2,
              profile: {
                ...profile,
                preferences: {
                  ...profile.preferences,
                  titles: ['Python Developer', 'FastAPI Engineer'],
                },
                application: { yearsOfExperience: 6 },
              },
            },
          })
        ).statusCode,
        200,
      );
      const replayed = await app.inject({
        method: 'POST',
        url: '/api/searches',
        cookies,
        headers,
        payload: request,
      });
      assert.equal(replayed.json().runId, created.json().runId);
      const profileReplay = await database.createSearch(
        ownerId,
        'saved-role-discovery',
        profileRequest,
      );
      assert.equal(profileReplay.id, profileDiscovery.id);
      assert.equal(profileReplay.profileRevision, 2);
      assert.deepEqual(profileReplay.matchingProfile, profileDiscovery.matchingProfile);
      assert.equal(
        (await database.getSearch(ownerId, replayed.json().runId))?.matchingProfile?.application
          .yearsOfExperience,
        5,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/searches',
            cookies,
            headers,
            payload: { ...request, query: 'Python' },
          })
        ).statusCode,
        409,
      );
      assert.equal(
        (await app.inject({ url: `/api/searches/${created.json().runId}`, cookies })).statusCode,
        200,
      );
      assert.equal(
        (await app.inject({ url: `/api/searches/${randomUUID()}`, cookies })).statusCode,
        404,
      );
      const cancelUrl = `/api/searches/${created.json().runId}/cancel`;
      assert.equal(
        (await app.inject({ method: 'POST', url: cancelUrl, headers: { origin } })).statusCode,
        401,
      );
      assert.equal(
        (await app.inject({ method: 'POST', url: cancelUrl, cookies, headers: { origin } }))
          .statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/searches/invalid/cancel',
            cookies,
            headers,
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `/api/searches/${randomUUID()}/cancel`,
            cookies,
            headers,
          })
        ).statusCode,
        404,
      );
      const cancelled = await app.inject({ method: 'POST', url: cancelUrl, cookies, headers });
      assert.equal(cancelled.statusCode, 200);
      assert.equal(cancelled.json().status, 'cancelled');
      assert.deepEqual(
        (await app.inject({ method: 'POST', url: cancelUrl, cookies, headers })).json(),
        cancelled.json(),
      );
      allowRequest = false;
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/leads',
            cookies,
            headers,
            payload: { jobId },
          })
        ).statusCode,
        429,
      );
      assert.equal(
        (
          await app.inject({
            method: 'PUT',
            url: leadUrl,
            cookies,
            headers,
            payload: { revision: 30, notes: '', status: 'saved' },
          })
        ).statusCode,
        429,
      );
      assert.equal((await app.inject({ url: exportUrl, cookies })).statusCode, 429);
      assert.equal(
        (await app.inject({ method: 'POST', url: cancelUrl, cookies, headers })).statusCode,
        429,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/login',
            headers: { origin },
            payload: { email: `${ownerId}@example.test`, password },
          })
        ).statusCode,
        429,
      );
      assert.equal(
        (await app.inject({ method: 'POST', url: '/api/logout', cookies, headers })).statusCode,
        200,
      );
      assert.equal((await app.inject({ url: '/api/searches', cookies })).statusCode, 401);
    } finally {
      await app.close();
    }
  } finally {
    await database.close();
    await admin.pool.query(`DROP DATABASE "${name}"`);
    await admin.close();
  }
});

// CS-22: the parsed resume never reached matching - collect.ts hardcoded
// derived: null regardless of what the owner had actually uploaded. This
// proves createSearch snapshots the most recent successfully-parsed resume's
// derived skills/titles/years onto matchingProfile, distinguishes "no resume"
// from "resume present" (never silently defaults one into looking like the
// other), and that a rejected or superseded parse is not used.
test('createSearch snapshots the latest parsed resume onto the matching profile, or null when absent', async () => {
  const configured = process.env.DATABASE_URL;
  assert.ok(configured, 'Integration tests require the isolated v2 DATABASE_URL');
  const base = new URL(configured);
  assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname), 'Tests require local PostgreSQL');
  const admin = new Database(configured);
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  base.pathname = `/${name}`;
  const database = new Database(base.href);
  try {
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL('../../../migrations', import.meta.url)),
    });
    const ownerId = randomUUID();
    await database.db.insert(users).values({
      id: ownerId,
      email: `${ownerId}@example.test`,
      passwordHash: 'synthetic-not-a-login',
    });
    const request = { query: 'React', sources: ['remoteok'] as ['remoteok'] };
    const profileRepo = new ProfileRepository(database);
    const syntheticProfile = writableProfileSchema.parse({
      candidate: {
        fullName: 'Example Candidate',
        email: 'candidate@example.test',
        location: 'Hyderabad',
      },
      preferences: { titles: ['React Engineer'], techStack: ['React'] },
      application: { yearsOfExperience: 2 },
    });
    await profileRepo.save(ownerId, { revision: 0, profile: syntheticProfile });

    // No resume uploaded yet: derived must be null, not omitted or defaulted
    // to something indistinguishable from "resume present but empty".
    const beforeResume = await database.createSearch(ownerId, 'before-resume', request);
    assert.equal(beforeResume.matchingProfile?.derived, null);

    const uploads = new ResumeUploadRepository(database);
    const settle = async (key: string, derived: DerivedResume) => {
      const reserved = await uploads.reserve(ownerId, key, 'synthetic-resumes', {
        sha256: 'a'.repeat(64),
        bytes: 100,
        contentType: 'application/pdf',
      });
      const queued = await uploads.queueStoredUpload(ownerId, reserved.id, 'v1');
      const command = await database.command(queued!.commandId!);
      const fence = await database.claim(command!.id);
      await uploads.settleParse(command!, fence!, {
        status: 'parsed',
        parsed: {
          format: 'pdf',
          text: 'Synthetic resume text body, forty characters minimum.',
          derived,
        },
      });
    };

    await settle('first-resume', {
      techStack: ['Kubernetes'],
      recentSkills: [],
      titles: [],
      yearsOfExperience: 3,
    });
    const afterFirstResume = await database.createSearch(ownerId, 'after-first-resume', request);
    assert.deepEqual(afterFirstResume.matchingProfile?.derived?.techStack, ['Kubernetes']);
    assert.equal(afterFirstResume.matchingProfile?.derived?.yearsOfExperience, 3);

    // A second, later resume must override the first - matching always uses
    // the most recent parse, not the first one it finds.
    await settle('second-resume', {
      techStack: ['Terraform'],
      recentSkills: [],
      titles: [],
      yearsOfExperience: 5,
    });
    const afterSecondResume = await database.createSearch(ownerId, 'after-second-resume', request);
    assert.deepEqual(afterSecondResume.matchingProfile?.derived?.techStack, ['Terraform']);
    assert.equal(afterSecondResume.matchingProfile?.derived?.yearsOfExperience, 5);

    // A rejected parse (corrupt/unreadable document) must never be treated as
    // resume data - the last genuinely *parsed* result still wins.
    const rejectedUpload = await uploads.reserve(ownerId, 'rejected-resume', 'synthetic-resumes', {
      sha256: 'b'.repeat(64),
      bytes: 100,
      contentType: 'application/pdf',
    });
    const rejectedQueued = await uploads.queueStoredUpload(ownerId, rejectedUpload.id, 'v1');
    const rejectedCommand = await database.command(rejectedQueued!.commandId!);
    const rejectedFence = await database.claim(rejectedCommand!.id);
    await uploads.settleParse(rejectedCommand!, rejectedFence!, {
      status: 'rejected',
      errorCode: 'invalid_document',
    });
    const afterRejected = await database.createSearch(ownerId, 'after-rejected', request);
    assert.deepEqual(afterRejected.matchingProfile?.derived?.techStack, ['Terraform']);

    // Owner isolation: a resume never leaks into another owner's profile.
    const otherOwner = randomUUID();
    await database.db.insert(users).values({
      id: otherOwner,
      email: `${otherOwner}@example.test`,
      passwordHash: 'synthetic-not-a-login',
    });
    await profileRepo.save(otherOwner, { revision: 0, profile: syntheticProfile });
    const otherSearch = await database.createSearch(otherOwner, 'other-owner-search', request);
    assert.equal(otherSearch.matchingProfile?.derived, null);

    // End to end: collect() actually folds the snapshotted derived skills into
    // the candidate context and scoring, closing CS-22's real gap - this was
    // never exercised before because collect.ts hardcoded derived: null
    // regardless of what searchHandler passed in.
    const withResume = await database.getSearch(ownerId, afterSecondResume.id);
    assert.ok(withResume?.matchingProfile);
    const candidateContext = buildCandidateContext(withResume.matchingProfile);
    assert.ok(candidateContext.resumeConsidered);
    assert.ok(candidateContext.skills.includes('Terraform'));
    assert.deepEqual(candidateContext.resumeSkills, ['Terraform']);

    const noResumeProfile = await database.getSearch(ownerId, beforeResume.id);
    const noResumeContext = buildCandidateContext(noResumeProfile!.matchingProfile!);
    assert.equal(noResumeContext.resumeConsidered, false);
    assert.deepEqual(noResumeContext.resumeSkills, []);
  } finally {
    await database.close();
    await admin.pool.query(`DROP DATABASE "${name}"`);
    await admin.close();
  }
});

// CS-23: a source that ran without error but returned zero rows must not be
// indistinguishable from an ordinary completed run, and a streak of empty
// runs for one source must be queryable so it can be surfaced.
test('recentSourceStatuses reports the most recent outcomes for one source across all owners, newest first', async (context) => {
  const configured = process.env.DATABASE_URL;
  assert.ok(configured, 'Integration tests require the isolated v2 DATABASE_URL');
  const base = new URL(configured);
  assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname), 'Tests require local PostgreSQL');
  const admin = new Database(configured);
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  base.pathname = `/${name}`;
  const database = new Database(base.href);
  try {
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL('../../../migrations', import.meta.url)),
    });
    const ownerA = randomUUID();
    const ownerB = randomUUID();
    for (const owner of [ownerA, ownerB]) {
      await database.db.insert(users).values({
        id: owner,
        email: `${owner}@example.test`,
        passwordHash: 'synthetic-not-a-login',
      });
    }
    const request = { query: 'React', sources: ['remoteok'] as ['remoteok'] };

    const runOnce = async (owner: string, key: string, outcome: SourceOutcome) => {
      const search = await database.createSearch(owner, key, request);
      const command = (await database.unpublished()).find(
        (entry) => entry.command.aggregateId === search.id,
      )!.command;
      const fence = await database.claim(command.id);
      await database.completeCollection(command, fence!, [], [outcome]);
      return search;
    };

    const empty = (extra: Partial<SourceOutcome> = {}): SourceOutcome => ({
      source: 'remoteok',
      status: 'empty',
      accepted: 0,
      limited: false,
      errorCode: null,
      ...extra,
    });
    const completed: SourceOutcome = {
      source: 'remoteok',
      status: 'completed',
      accepted: 1,
      limited: false,
      errorCode: null,
    };

    // No history yet.
    assert.deepEqual(await database.recentSourceStatuses('remoteok', 5), []);

    // Oldest run: a real result. Then four consecutive empty runs, spanning
    // two different owners - source health is global, not per-owner.
    await runOnce(ownerA, 'run-1', completed);
    await runOnce(ownerB, 'run-2', empty());
    await runOnce(ownerA, 'run-3', empty());
    await runOnce(ownerB, 'run-4', empty());
    await runOnce(ownerA, 'run-5', empty());

    const last4 = await database.recentSourceStatuses('remoteok', 4);
    assert.deepEqual(last4, ['empty', 'empty', 'empty', 'empty']);
    const last5 = await database.recentSourceStatuses('remoteok', 5);
    assert.deepEqual(last5, ['empty', 'empty', 'empty', 'empty', 'completed']);

    // A different source's history is untouched.
    assert.deepEqual(await database.recentSourceStatuses('himalayas', 5), []);

    // searchHandler must not throw when the streak-check path executes for
    // real, and must actually log the empty-streak warning once the threshold
    // (5 consecutive) is met - spied directly, not inferred from DB state
    // alone (Independent Reviewer finding CS-23-A: a passing DB-read assertion
    // proves persistence works but says nothing about whether the alert
    // itself fires).
    const warnCalls: unknown[][] = [];
    context.mock.method(logger, 'warn', (...args: unknown[]) => {
      warnCalls.push(args);
    });
    const handler = searchHandler(database, [{ ...createRemoteOkProvider(), async *search() {} }]);
    const sixthSearch = await database.createSearch(ownerA, 'run-6-via-handler', request);
    const sixthCommand = (await database.unpublished()).find(
      (entry) => entry.command.aggregateId === sixthSearch.id,
    )!.command;
    const sixthFence = await database.claim(sixthCommand.id);
    await assert.doesNotReject(handler(sixthCommand, sixthFence!, new AbortController().signal));
    const streak = await database.recentSourceStatuses('remoteok', 5);
    assert.ok(
      streak.every((status) => status === 'empty'),
      'five consecutive empty runs now on record',
    );
    assert.equal(warnCalls.length, 1, 'the empty-streak warning must fire exactly once');
    assert.deepEqual(warnCalls[0]![0], {
      source: 'remoteok',
      consecutiveEmptyRuns: 5,
    });
    context.mock.restoreAll();
  } finally {
    await database.close();
    await admin.pool.query(`DROP DATABASE "${name}"`);
    await admin.close();
  }
});

test('CS-35: conflicts carry a stable code and the HTTP layer surfaces distinct, safe messages', async () => {
  const configured = process.env.DATABASE_URL;
  assert.ok(configured, 'Integration tests require the isolated v2 DATABASE_URL');
  const base = new URL(configured);
  assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname), 'Tests require local PostgreSQL');
  const admin = new Database(configured);
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  base.pathname = `/${name}`;
  const database = new Database(base.href);
  try {
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL('../../../migrations', import.meta.url)),
    });
    const ownerId = randomUUID();
    const password = 'synthetic-password-1234';
    await database.db.insert(users).values({
      id: ownerId,
      email: `${ownerId}@example.test`,
      passwordHash: await passwordHash(password),
    });
    const request = { query: 'React', sources: ['remoteok'] as ['remoteok'] };

    // MISSING_TARGET_ROLES: no profile saved at all yet, so useProfileTitles
    // has nothing to snapshot - the real, product-meaningful case, not a
    // synthetic one.
    await assert.rejects(
      database.createSearch(ownerId, 'no-profile-key', { ...request, useProfileTitles: true }),
      (error: unknown) => error instanceof Conflict && error.code === 'MISSING_TARGET_ROLES',
    );

    // IDEMPOTENCY_KEY_REUSED: same key, a request that hashes differently.
    const reusedKey = 'shared-idempotency-key';
    await database.createSearch(ownerId, reusedKey, request);
    await assert.rejects(
      database.createSearch(ownerId, reusedKey, { ...request, query: 'Vue' }),
      (error: unknown) => error instanceof Conflict && error.code === 'IDEMPOTENCY_KEY_REUSED',
    );

    // The real HTTP layer must expose the code, and a distinct, safe message
    // per code - not the same "Idempotency conflict" string for both.
    const origin = 'http://localhost:5280';
    const app = await createApp(database, origin, async () => true);
    try {
      const login = await app.inject({
        method: 'POST',
        url: '/api/login',
        headers: { origin },
        payload: { email: `${ownerId}@example.test`, password },
      });
      const sessionCookie = login.cookies[0]!;
      const cookies = { [sessionCookie.name]: sessionCookie.value };
      const sessionRes = await app.inject({ url: '/api/session', cookies });
      const csrf = sessionRes.json().csrf as string;

      const missingTitles = await app.inject({
        method: 'POST',
        url: '/api/searches',
        headers: { origin, 'x-csrf-token': csrf, 'idempotency-key': randomUUID() },
        cookies,
        payload: { ...request, useProfileTitles: true },
      });
      assert.equal(missingTitles.statusCode, 409);
      assert.deepEqual(Object.keys(missingTitles.json()), ['error', 'code', 'requestId']);
      assert.equal(missingTitles.json().code, 'MISSING_TARGET_ROLES');
      assert.equal(
        missingTitles.json().error,
        'Add target roles to your profile before starting this search',
      );

      const key = randomUUID();
      const first = await app.inject({
        method: 'POST',
        url: '/api/searches',
        headers: { origin, 'x-csrf-token': csrf, 'idempotency-key': key },
        cookies,
        payload: request,
      });
      assert.equal(first.statusCode, 202);
      const second = await app.inject({
        method: 'POST',
        url: '/api/searches',
        headers: { origin, 'x-csrf-token': csrf, 'idempotency-key': key },
        cookies,
        payload: { ...request, query: 'Vue' },
      });
      assert.equal(second.statusCode, 409);
      assert.equal(second.json().code, 'IDEMPOTENCY_KEY_REUSED');
      assert.equal(
        second.json().error,
        'This request already completed with different details; try again',
      );
      assert.notEqual(missingTitles.json().error, second.json().error);

      // An internal conflict that was never given a specific code must still
      // fail safely through the REAL error handler: the generic 409 message,
      // never the raw Error.message, and never a success. Exercised by
      // injecting a request whose repository call throws - asserting on the
      // Conflict constructor here would have tested the class, not the
      // handler this test names (Independent Reviewer, 2026-09-25).
      const originalCreateSearch = database.createSearch;
      const internalDetail = 'Search command missing: relation "search_commands" is locked';
      for (const thrown of [
        new Conflict(internalDetail),
        new Conflict(internalDetail, 'SOME_FUTURE_CODE_THE_HANDLER_DOES_NOT_MAP'),
      ]) {
        database.createSearch = async () => {
          throw thrown;
        };
        try {
          const unmapped = await app.inject({
            method: 'POST',
            url: '/api/searches',
            headers: { origin, 'x-csrf-token': csrf, 'idempotency-key': randomUUID() },
            cookies,
            payload: request,
          });
          assert.equal(unmapped.statusCode, 409);
          assert.deepEqual(Object.keys(unmapped.json()), ['error', 'code', 'requestId']);
          assert.equal(unmapped.json().error, 'Idempotency conflict');
          assert.ok(
            !unmapped.payload.includes('search_commands'),
            'the raw internal message must not reach the client',
          );
        } finally {
          database.createSearch = originalCreateSearch;
        }
      }
      // The unspecified case keeps the stable default code, so a client can
      // tell "some conflict" from a conflict it knows how to act on.
      database.createSearch = async () => {
        throw new Conflict(internalDetail);
      };
      try {
        const generic = await app.inject({
          method: 'POST',
          url: '/api/searches',
          headers: { origin, 'x-csrf-token': csrf, 'idempotency-key': randomUUID() },
          cookies,
          payload: request,
        });
        assert.equal(generic.json().code, 'CONFLICT');
      } finally {
        database.createSearch = originalCreateSearch;
      }
    } finally {
      await app.close();
    }
  } finally {
    await database.close();
    await admin.pool.query(`DROP DATABASE "${name}"`);
    await admin.close();
  }
});

test('CS-57: logging out answers identically with no cookie, a stale cookie and a live session', async () => {
  const configured = process.env.DATABASE_URL;
  assert.ok(configured, 'Integration tests require the isolated v2 DATABASE_URL');
  const base = new URL(configured);
  assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname), 'Tests require local PostgreSQL');
  const admin = new Database(configured);
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  base.pathname = `/${name}`;
  const database = new Database(base.href);
  try {
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL('../../../migrations', import.meta.url)),
    });
    const ownerId = randomUUID();
    const password = 'synthetic-password-1234';
    await database.db.insert(users).values({
      id: ownerId,
      email: `${ownerId}@example.test`,
      passwordHash: await passwordHash(password),
    });
    const origin = 'http://localhost:5280';
    const app = await createApp(database, origin, async () => true);
    try {
      // No cookie at all: the path the hook never guaranteed, where the old
      // non-null assertion could only have produced a 500.
      const noCookie = await app.inject({
        method: 'POST',
        url: '/api/logout',
        headers: { origin },
      });
      assert.equal(noCookie.statusCode, 200);
      assert.deepEqual(noCookie.json(), { authenticated: false });

      // A syntactically plausible cookie naming no live session must not be
      // distinguishable from the one above.
      const staleCookie = await app.inject({
        method: 'POST',
        url: '/api/logout',
        headers: { origin },
        cookies: { [sessionCookie]: 'f'.repeat(64) },
      });
      assert.equal(staleCookie.statusCode, noCookie.statusCode);
      assert.deepEqual(staleCookie.json(), noCookie.json());

      const login = await app.inject({
        method: 'POST',
        url: '/api/login',
        headers: { origin },
        payload: { email: `${ownerId}@example.test`, password },
      });
      const issued = login.cookies[0]!;
      const cookies = { [issued.name]: issued.value };
      const csrf = (await app.inject({ url: '/api/session', cookies })).json().csrf as string;

      // The no-session exemption must not have weakened CSRF for a request
      // that does carry a session.
      const forged = await app.inject({
        method: 'POST',
        url: '/api/logout',
        headers: { origin },
        cookies,
      });
      assert.equal(forged.statusCode, 403);

      const realLogout = await app.inject({
        method: 'POST',
        url: '/api/logout',
        headers: { origin, 'x-csrf-token': csrf },
        cookies,
      });
      assert.equal(realLogout.statusCode, noCookie.statusCode);
      assert.deepEqual(realLogout.json(), noCookie.json());
      // The session was genuinely destroyed, not merely reported as gone.
      assert.equal((await app.inject({ url: '/api/leads', cookies })).statusCode, 401);

      // Security review P3, 2026-09-25: the exemption is method-qualified, so
      // it must not extend to any other verb on the same path. GET is the one
      // that matters — it is also excluded from the Origin check above, so an
      // unqualified exemption would have made a future `app.get('/api/logout')`
      // both anonymous and origin-exempt. No GET route is registered, so an
      // unmatched route must still answer 401 from the hook rather than
      // slipping through the exemption.
      assert.equal(
        (await app.inject({ method: 'GET', url: '/api/logout' })).statusCode,
        401,
        'GET /api/logout must not inherit the POST no-session exemption',
      );

      // The exemption is pinned to the routed path, not a raw URL, so a
      // neighbouring path cannot reach it.
      assert.equal(
        (await app.inject({ method: 'POST', url: '/api/logout-other', headers: { origin } }))
          .statusCode,
        401,
        'only /api/logout itself may take the no-session exemption',
      );

      // CS-48 F-1 / CS-39 AC2: the preparation screen rendered a FIXED
      // "AI inference off" caption above live "Get AI coaching" buttons, so it
      // stated the opposite of the truth whenever AI was enabled. The screen
      // now derives both the caption and the button from this flag, which
      // makes the flag itself load-bearing — assert it actually reflects the
      // server's configuration in both directions rather than being a constant.
      //
      // Two separate apps, because `aiProvider` is fixed at construction. The
      // config is synthetic and no network call is possible: nothing here
      // reaches OpenRouter, and the flag is computed from presence alone.
      const capabilityLogin = await app.inject({
        method: 'POST',
        url: '/api/login',
        headers: { origin },
        payload: { email: `${ownerId}@example.test`, password },
      });
      const fresh = capabilityLogin.cookies[0]!;
      const offSession = await app.inject({
        url: '/api/session',
        cookies: { [fresh.name]: fresh.value },
      });
      assert.equal(
        offSession.json().aiEnabled,
        false,
        'session must report aiEnabled false when no provider is configured',
      );
      // The key must never travel to the client, only the capability.
      assert.equal(
        JSON.stringify(offSession.json()).includes('synthetic-key'),
        false,
        'the session payload must never carry provider credentials',
      );

      const aiApp = await createApp(database, origin, async () => true, {
        aiProvider: { apiKey: 'synthetic-key', model: 'synthetic/model:free' },
      });
      try {
        const aiLogin = await aiApp.inject({
          method: 'POST',
          url: '/api/login',
          headers: { origin },
          payload: { email: `${ownerId}@example.test`, password },
        });
        const aiCookie = aiLogin.cookies[0]!;
        const onSession = await aiApp.inject({
          url: '/api/session',
          cookies: { [aiCookie.name]: aiCookie.value },
        });
        assert.equal(
          onSession.json().aiEnabled,
          true,
          'session must report aiEnabled true when a provider is configured',
        );
        assert.equal(
          JSON.stringify(onSession.json()).includes('synthetic-key'),
          false,
          'the session payload must never carry provider credentials',
        );
      } finally {
        await aiApp.close();
      }
    } finally {
      await app.close();
    }
  } finally {
    await database.close();
    await admin.pool.query(`DROP DATABASE "${name}"`);
    await admin.close();
  }
});

test('CS-61: the session carries a stable, opaque per-owner cache key that differs between owners', async () => {
  const configured = process.env.DATABASE_URL;
  assert.ok(configured, 'Integration tests require the isolated v2 DATABASE_URL');
  const base = new URL(configured);
  assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname), 'Tests require local PostgreSQL');
  const admin = new Database(configured);
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  base.pathname = `/${name}`;
  const database = new Database(base.href);
  try {
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL('../../../migrations', import.meta.url)),
    });
    const password = 'synthetic-password-1234';
    const hashed = await passwordHash(password);
    const first = randomUUID();
    const second = randomUUID();
    // Emails deliberately do NOT embed the owner id: the payload is asserted
    // below not to carry the raw id, and an id-derived email would satisfy
    // that assertion by accident in the wrong direction.
    const emails = { [first]: 'cs61-first@example.test', [second]: 'cs61-second@example.test' };
    for (const id of [first, second])
      await database.db.insert(users).values({ id, email: emails[id]!, passwordHash: hashed });
    const origin = 'http://localhost:5280';
    const app = await createApp(database, origin, async () => true, {
      registrationEnabled: false,
    });
    const sessionFor = async (id: string) => {
      const login = await app.inject({
        method: 'POST',
        url: '/api/login',
        headers: { origin },
        payload: { email: emails[id]!, password },
      });
      assert.equal(login.statusCode, 200, 'the synthetic owner must actually sign in');
      const issued = login.cookies[0]!;
      const response = await app.inject({
        url: '/api/session',
        cookies: { [issued.name]: issued.value },
      });
      assert.equal(response.statusCode, 200);
      return response.json() as {
        authenticated: boolean;
        email?: string;
        owner?: string;
        csrf?: string;
      };
    };
    try {
      // POSITIVE FIRST, ALWAYS. Every claim below is about telling two owners
      // apart, and `undefined !== undefined` is false while `undefined` is
      // also a perfectly stable value — so an endpoint that had simply
      // stopped returning the key would satisfy a naive difference assertion.
      // Prove each surface loaded, AS THE IDENTITY EXPECTED, before asserting
      // anything about what it must not contain.
      const firstSession = await sessionFor(first);
      assert.equal(firstSession.authenticated, true);
      assert.equal(firstSession.email, emails[first], 'session one is owner one');
      assert.equal(
        typeof firstSession.owner,
        'string',
        'the session must expose an owner cache key; without it the client cannot scope its keys at all',
      );
      assert.match(firstSession.owner!, /^[a-f0-9]{64}$/);

      const secondSession = await sessionFor(second);
      assert.equal(secondSession.authenticated, true);
      assert.equal(secondSession.email, emails[second], 'session two is owner two');
      assert.match(secondSession.owner!, /^[a-f0-9]{64}$/);

      // The contract CS-61 depends on: two owners never share a cache key.
      assert.notEqual(
        firstSession.owner,
        secondSession.owner,
        'two owners must never receive the same cache key, or owner-keyed queries collapse back into one bucket',
      );

      // Stability. A key that changed per sign-in would still isolate owners,
      // but it would silently discard an owner's own cache on every login, so
      // the difference assertion above is not sufficient on its own.
      const again = await sessionFor(first);
      assert.equal(again.email, emails[first]);
      assert.equal(
        again.owner,
        firstSession.owner,
        'the same owner must keep the same cache key across sign-ins',
      );
      assert.notEqual(
        again.csrf,
        firstSession.csrf,
        'the fixture must really be a second, distinct session - otherwise stability was never exercised',
      );

      // Opaque: the key must not BE the owner id. ownerId is the one value
      // that must never arrive from a client, so it must not be published to
      // one either. This is what stops the digest being "simplified" later.
      assert.notEqual(firstSession.owner, first);
      assert.equal(
        JSON.stringify(firstSession).includes(first),
        false,
        'the session payload must not carry the raw owner id',
      );

      // An unauthenticated caller has no owner, so it must get no key -
      // asserted only after the authenticated case above proved the field is
      // emitted at all, so this cannot pass by the field having disappeared.
      const anonymous = await app.inject({ url: '/api/session' });
      assert.equal(anonymous.statusCode, 200);
      assert.equal(anonymous.json().authenticated, false);
      assert.equal(anonymous.json().owner, undefined);
    } finally {
      await app.close();
    }
  } finally {
    await database.close();
    await admin.pool.query(`DROP DATABASE "${name}"`);
    await admin.close();
  }
});

test('CS-48 AC10: ai-elaborate is owner-scoped, and a provider failure never reaches the deterministic operation', async () => {
  const configured = process.env.DATABASE_URL;
  assert.ok(configured, 'Integration tests require the isolated v2 DATABASE_URL');
  const base = new URL(configured);
  assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname), 'Tests require local PostgreSQL');
  const admin = new Database(configured);
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  base.pathname = `/${name}`;
  const database = new Database(base.href);
  // A real local HTTP server standing in for OpenRouter. No real provider call
  // is possible from this test: the base URL is redirected for its whole
  // lifetime and restored in the finally below.
  let upstream: (path: string, res: ServerResponse) => void = (_path, res) =>
    res.writeHead(500).end('{}');
  const bodies: string[] = [];
  const server = createServer((req, res) => upstream(req.url ?? '', res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  _setBaseUrlForTests(`http://127.0.0.1:${address.port}`);
  const catalog = JSON.stringify({
    data: [{ id: 'synthetic/model:free', pricing: { prompt: '0', completion: '0' } }],
  });
  const respond = (content: string) => (path: string, res: ServerResponse) => {
    if (path === '/models') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(catalog);
      return;
    }
    const chunks: Buffer[] = [];
    res.req.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.req.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('utf8'));
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  };
  try {
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL('../../../migrations', import.meta.url)),
    });
    const password = 'synthetic-password-1234';
    const hashed = await passwordHash(password);
    const owners = {
      first: { id: randomUUID(), email: 'cs48-owner-one@example.test', title: 'Kotlin Engineer' },
      second: { id: randomUUID(), email: 'cs48-owner-two@example.test', title: 'Rust Engineer' },
    };
    for (const owner of Object.values(owners))
      await database.db
        .insert(users)
        .values({ id: owner.id, email: owner.email, passwordHash: hashed });
    const origin = 'http://localhost:5280';
    const app = await createApp(database, origin, async () => true, {
      aiProvider: { apiKey: 'synthetic-key', model: 'synthetic/model:free' },
    });
    const signIn = async (email: string) => {
      const login = await app.inject({
        method: 'POST',
        url: '/api/login',
        headers: { origin },
        payload: { email, password },
      });
      assert.equal(login.statusCode, 200);
      const issued = login.cookies[0]!;
      const cookies = { [issued.name]: issued.value };
      const csrf = (await app.inject({ url: '/api/session', cookies })).json().csrf as string;
      return { cookies, headers: { origin, 'x-csrf-token': csrf } };
    };
    try {
      const sessions: Record<string, Awaited<ReturnType<typeof signIn>>> = {};
      for (const [key, owner] of Object.entries(owners)) {
        const session = await signIn(owner.email);
        sessions[key] = session;
        const saved = await app.inject({
          method: 'PUT',
          url: '/api/profile',
          cookies: session.cookies,
          headers: session.headers,
          payload: {
            revision: 0,
            profile: {
              candidate: {
                fullName: 'Example Candidate',
                email: owner.email,
                location: 'Hyderabad',
              },
              preferences: { titles: [owner.title], techStack: ['TypeScript'] },
              application: { yearsOfExperience: 4 },
            },
          },
        });
        assert.equal(saved.statusCode, 200, 'the fixture profile must really be saved');
      }

      // OWNER ISOLATION. The route takes no owner from the request - it is
      // derived from the session - so the only way to test it is to ask the
      // SAME checkId as two different owners and prove each got their own
      // profile. Positive on the same surface first: each response must be a
      // real 200 naming that owner's own target role.
      upstream = respond('Coaching text.');
      for (const [key, owner] of Object.entries(owners)) {
        bodies.length = 0;
        const response = await app.inject({
          method: 'POST',
          url: '/api/preparation/target/ai-elaborate',
          cookies: sessions[key]!.cookies,
          headers: sessions[key]!.headers,
        });
        assert.equal(response.statusCode, 200);
        assert.equal(response.json().source, 'ai');
        assert.equal(bodies.length, 1, 'exactly one provider request per elaboration');
        const other = key === 'first' ? owners.second : owners.first;
        assert.ok(
          bodies[0]!.includes(owner.title),
          `${key} must be elaborated against their own saved target role`,
        );
        assert.equal(
          bodies[0]!.includes(other.title),
          false,
          `${key} received another owner's profile data`,
        );
      }

      // PROVIDER FAILURE IS ISOLATED FROM THE UNDERLYING OPERATION. The
      // deterministic report is what the product actually depends on; the AI
      // note is an addition to it. A failing provider must map to a typed
      // status, and must not take the deterministic operation down with it,
      // nor change what it returns.
      const before = await app.inject({
        url: '/api/preparation',
        cookies: sessions.first!.cookies,
      });
      assert.equal(before.statusCode, 200);
      upstream = (path, res) => {
        if (path === '/models')
          res.writeHead(200, { 'content-type': 'application/json' }).end(catalog);
        else res.writeHead(500).end('{}');
      };
      const failed = await app.inject({
        method: 'POST',
        url: '/api/preparation/target/ai-elaborate',
        cookies: sessions.first!.cookies,
        headers: sessions.first!.headers,
      });
      assert.equal(failed.statusCode, 502, 'a provider 5xx is a typed 502, never a 500 or a 200');
      assert.equal(
        JSON.stringify(failed.json()).includes('synthetic-key'),
        false,
        'a provider failure must never echo the API key',
      );
      const after = await app.inject({
        url: '/api/preparation',
        cookies: sessions.first!.cookies,
      });
      assert.equal(after.statusCode, 200);
      assert.deepEqual(
        after.json(),
        before.json(),
        'the deterministic report must be unchanged by a failed AI call',
      );
    } finally {
      await app.close();
    }

    // AI OFF IS THE DEFAULT, and the route must refuse rather than fall back.
    const offApp = await createApp(database, origin, async () => true);
    try {
      const session = await (async () => {
        const login = await offApp.inject({
          method: 'POST',
          url: '/api/login',
          headers: { origin },
          payload: { email: owners.first.email, password },
        });
        const issued = login.cookies[0]!;
        const cookies = { [issued.name]: issued.value };
        const csrf = (await offApp.inject({ url: '/api/session', cookies })).json().csrf as string;
        return { cookies, headers: { origin, 'x-csrf-token': csrf } };
      })();
      bodies.length = 0;
      const refused = await offApp.inject({
        method: 'POST',
        url: '/api/preparation/target/ai-elaborate',
        cookies: session.cookies,
        headers: session.headers,
      });
      assert.equal(refused.statusCode, 503);
      assert.equal(bodies.length, 0, 'a disabled provider must not be contacted at all');
      // Paired positive: the same session reaches the deterministic route.
      assert.equal(
        (await offApp.inject({ url: '/api/preparation', cookies: session.cookies })).statusCode,
        200,
      );
    } finally {
      await offApp.close();
    }

    // Unauthenticated callers never reach the provider either.
    const anonymousApp = await createApp(database, origin, async () => true, {
      aiProvider: { apiKey: 'synthetic-key', model: 'synthetic/model:free' },
    });
    try {
      bodies.length = 0;
      const anonymous = await anonymousApp.inject({
        method: 'POST',
        url: '/api/preparation/target/ai-elaborate',
        headers: { origin },
      });
      assert.equal(anonymous.statusCode, 401);
      assert.equal(bodies.length, 0);
    } finally {
      await anonymousApp.close();
    }
  } finally {
    _setBaseUrlForTests(undefined);
    _resetCatalogCacheForTests();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await database.close();
    await admin.pool.query(`DROP DATABASE "${name}"`);
    await admin.close();
  }
});

test('CS-55: every authenticated read carries an owner-keyed budget, and the buckets are separate', async () => {
  const configured = process.env.DATABASE_URL;
  assert.ok(configured, 'Integration tests require the isolated v2 DATABASE_URL');
  const base = new URL(configured);
  assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname), 'Tests require local PostgreSQL');
  const admin = new Database(configured);
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  base.pathname = `/${name}`;
  const database = new Database(base.href);
  try {
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL('../../../migrations', import.meta.url)),
    });
    const password = 'synthetic-password-1234';
    const hashed = await passwordHash(password);
    const first = randomUUID();
    const second = randomUUID();
    const emails = { [first]: 'cs55-one@example.test', [second]: 'cs55-two@example.test' };
    for (const id of [first, second])
      await database.db.insert(users).values({ id, email: emails[id]!, passwordHash: hashed });
    const origin = 'http://localhost:5280';
    // A real counting limiter, not a stub that always allows: refusal has to be
    // reachable or the 429 assertions below could never fire.
    const consumed: string[] = [];
    const counts = new Map<string, number>();
    const exhausted = new Set<string>();
    const rateLimit = async (key: string, limit: number) => {
      consumed.push(key);
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      if (exhausted.has(key)) return false;
      return count <= limit;
    };
    const app = await createApp(database, origin, rateLimit);
    const signIn = async (id: string) => {
      const login = await app.inject({
        method: 'POST',
        url: '/api/login',
        headers: { origin },
        payload: { email: emails[id]!, password },
      });
      assert.equal(login.statusCode, 200);
      const issued = login.cookies[0]!;
      return { [issued.name]: issued.value };
    };
    try {
      const cookies = await signIn(first);
      const otherCookies = await signIn(second);
      const leadId = randomUUID();
      // The eleven routes CS-55 names, enumerated rather than sampled - a
      // sampled check would have missed whichever one was forgotten, which is
      // how all eleven came to be unlimited in the first place.
      const reads = [
        ['/api/leads', 'leads-read'],
        [`/api/leads/${leadId}`, 'leads-read'],
        [`/api/leads/${leadId}/history`, 'leads-read'],
        ['/api/searches', 'searches-read'],
        [`/api/searches/${randomUUID()}`, 'searches-read'],
        ['/api/profile', 'profile-read'],
        ['/api/market/postings', 'market-read'],
        ['/api/market/postings/synthetic-fingerprint', 'market-read'],
        ['/api/market/companies', 'market-read'],
        ['/api/pipeline', 'market-read'],
        ['/api/pipeline/stalled', 'market-read'],
      ] as const;
      for (const [url, bucket] of reads) {
        consumed.length = 0;
        const response = await app.inject({ url, cookies });
        // POSITIVE FIRST: the route was really reached as this owner. A 401 or
        // a 500 would satisfy "the limiter was not bypassed" for the wrong
        // reason, so the status is asserted before the key is.
        assert.ok(
          [200, 404].includes(response.statusCode),
          `${url} answered ${response.statusCode}, so nothing below is about a working read`,
        );
        assert.ok(consumed.includes(`${bucket}:${first}`), `${url} consumed no owner budget`);
        assert.equal(
          consumed.some((key) => key.endsWith(second)),
          false,
          `${url} charged the wrong owner`,
        );
      }

      // Refusal really refuses, on the route and with the status the client
      // must see. Without this the budget is a counter nobody enforces.
      exhausted.add(`leads-read:${first}`);
      assert.equal((await app.inject({ url: '/api/leads', cookies })).statusCode, 429);
      assert.equal(
        (await app.inject({ url: `/api/leads/${leadId}`, cookies })).statusCode,
        429,
        'the whole leads-read bucket is exhausted, not one URL',
      );

      // The events route's own limiter sits BEFORE its database work now, not
      // after it. Observable precisely: with the budget exhausted, a request
      // for a run that does not exist answers 429 rather than 404 — which it
      // could only do if the limit were consulted before the run lookup.
      // Paired positive first, on the same surface, with the budget intact.
      const absentRun = randomUUID();
      assert.equal(
        (await app.inject({ url: `/api/searches/${absentRun}/events`, cookies })).statusCode,
        404,
        'with budget remaining the route must still reach the lookup and answer 404',
      );
      exhausted.add(`events:${first}`);
      assert.equal(
        (await app.inject({ url: `/api/searches/${absentRun}/events`, cookies })).statusCode,
        429,
        'an exhausted events budget must be refused before the database is queried',
      );
      // THE BUCKETS ARE SEPARATE, and the key is the owner. Both of these are
      // paired positives for the refusal above: if exhausting one bucket shut
      // everything down, or shut the other owner down, the limiter would be a
      // global kill switch rather than a per-owner budget.
      assert.equal(
        (await app.inject({ url: '/api/searches', cookies })).statusCode,
        200,
        'an exhausted leads budget must not take the searches read down with it',
      );
      assert.equal(
        (await app.inject({ url: '/api/leads', cookies: otherCookies })).statusCode,
        200,
        'one owner exhausting their budget must never lock out another owner',
      );
    } finally {
      await app.close();
    }
  } finally {
    await database.close();
    await admin.pool.query(`DROP DATABASE "${name}"`);
    await admin.close();
  }
});

test('CS-53: a run event or job belonging to a different owner than its run is unrepresentable', async () => {
  const configured = process.env.DATABASE_URL;
  assert.ok(configured, 'Integration tests require the isolated v2 DATABASE_URL');
  const base = new URL(configured);
  assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname), 'Tests require local PostgreSQL');
  const admin = new Database(configured);
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  base.pathname = `/${name}`;
  const database = new Database(base.href);
  try {
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL('../../../migrations', import.meta.url)),
    });
    const hashed = await passwordHash('synthetic-password-1234');
    const owner = randomUUID();
    const intruder = randomUUID();
    for (const id of [owner, intruder])
      await database.db
        .insert(users)
        .values({ id, email: `cs53-${id}@example.test`, passwordHash: hashed });
    const runId = randomUUID();
    await database.pool.query(
      `INSERT INTO search_runs (id, owner_id, request, request_hash, idempotency_key)
       VALUES ($1, $2, $3::jsonb, $4, $5)`,
      [runId, owner, JSON.stringify({ titles: ['Engineer'] }), 'synthetic-hash', 'cs53-key-000001'],
    );

    // POSITIVE FIRST, on the same surface. Every assertion below is a refusal,
    // and a refusal proves nothing against a table that refuses everybody: the
    // rightful owner's rows must still insert.
    const eventId = randomUUID();
    const jobId = randomUUID();
    await database.pool.query(
      'INSERT INTO run_events (id, run_id, owner_id, type) VALUES ($1, $2, $3, $4)',
      [eventId, runId, owner, 'started'],
    );
    await database.pool.query(
      `INSERT INTO search_jobs (id, run_id, owner_id, fingerprint, data)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [jobId, runId, owner, 'cs53-fingerprint', JSON.stringify({ title: 'Engineer' })],
    );
    assert.equal(
      (await database.pool.query('SELECT 1 FROM run_events WHERE id = $1', [eventId])).rowCount,
      1,
    );
    assert.equal(
      (await database.pool.query('SELECT 1 FROM search_jobs WHERE id = $1', [jobId])).rowCount,
      1,
    );

    // THE INTRUDER IS A REAL USER. That matters: while owner_id referenced
    // users.id separately, this row satisfied both constraints - a valid user
    // and a valid run - and only the application layer stopped it existing.
    // It must now fail on the FOREIGN KEY, not on a missing user.
    for (const insert of [
      {
        what: 'run_events',
        sql: 'INSERT INTO run_events (id, run_id, owner_id, type) VALUES ($1, $2, $3, $4)',
        values: [randomUUID(), runId, intruder, 'started'],
      },
      {
        what: 'search_jobs',
        sql: `INSERT INTO search_jobs (id, run_id, owner_id, fingerprint, data)
              VALUES ($1, $2, $3, $4, $5::jsonb)`,
        values: [
          randomUUID(),
          runId,
          intruder,
          'cs53-other-fingerprint',
          JSON.stringify({ title: 'Engineer' }),
        ],
      },
    ]) {
      await assert.rejects(
        database.pool.query(insert.sql, insert.values),
        (error: unknown) => {
          const failure = error as { code?: string; constraint?: string };
          // 23503 is foreign_key_violation. Asserting the CODE, not a message:
          // a row rejected for any other reason would not prove the composite
          // key is what refused it.
          assert.equal(failure.code, '23503', `${insert.what} failed with ${failure.code}`);
          assert.match(String(failure.constraint), /owner_id_run_id/);
          return true;
        },
        `${insert.what} accepted a row whose owner is not the owner of its run`,
      );
    }

    // The composite key needs search_runs (owner_id, id) to be unique, or
    // Postgres refuses to create it at all (42830). Assert the prerequisite
    // exists rather than trusting that migration 0015 ran.
    const unique = await database.pool.query(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'search_runs' AND indexname = 'search_owner_id'`,
    );
    assert.equal(unique.rowCount, 1, 'the composite FK prerequisite index is missing');
    assert.match(String(unique.rows[0]!.indexdef), /UNIQUE/);
  } finally {
    await database.close();
    await admin.pool.query(`DROP DATABASE "${name}"`);
    await admin.close();
  }
});

test('createSearch takes UNPARSED input, and canonicalises it before storing or hashing', async () => {
  const configured = process.env.DATABASE_URL;
  assert.ok(configured, 'Integration tests require the isolated v2 DATABASE_URL');
  const base = new URL(configured);
  assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname), 'Tests require local PostgreSQL');
  const admin = new Database(configured);
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  base.pathname = `/${name}`;
  const database = new Database(base.href);
  try {
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL('../../../migrations', import.meta.url)),
    });
    const ownerId = randomUUID();
    await database.db.insert(users).values({
      id: ownerId,
      email: 'canonical@example.test',
      passwordHash: await passwordHash('synthetic-password-1234'),
    });

    // The parameter takes z.input: `origin` is optional on input and required
    // on output, so this call is valid and used to be a type error at 36 sites.
    const run = await database.createSearch(ownerId, 'canonical-key', {
      query: 'Platform Engineer',
      sources: ['himalayas', 'greenhouse'],
    });
    // STORED CANONICAL, not stored as handed in. `searches.request` is typed as
    // the schema's OUTPUT and CS-26 added `origin` so an auditor can tell an
    // unattended run from a human one - a row without it cannot answer that.
    assert.equal(run.request.origin, 'manual');
    assert.deepEqual(run.request.sources, ['greenhouse', 'himalayas'], 'sources are sorted');

    // The hash is taken over the canonical form, so a differently-ordered
    // spelling of the SAME request is the same request. Before the parse moved
    // inside, these two hashed differently and the second call would have been
    // rejected as a reused key - a false conflict on identical intent.
    const preParsed = createSearchSchema.parse({
      query: 'Platform Engineer',
      sources: ['greenhouse', 'himalayas'],
    });
    const reordered = await database.createSearch(ownerId, 'canonical-key', preParsed);
    assert.equal(
      reordered.id,
      run.id,
      'a literal and a pre-parsed form of the same request are idempotent',
    );

    // PAIRED POSITIVE: conflict detection is not weakened. A genuinely
    // different request under the same key must still be refused, or the
    // assertion above would be satisfied by a check that never fires.
    await assert.rejects(
      database.createSearch(ownerId, 'canonical-key', {
        query: 'Data Engineer',
        sources: ['greenhouse', 'himalayas'],
      }),
      (error: unknown) => error instanceof Conflict && error.code === 'IDEMPOTENCY_KEY_REUSED',
    );

    // And invalid input is still refused at this boundary rather than stored.
    await assert.rejects(
      database.createSearch(ownerId, 'invalid-key', { query: 'x', sources: [] }),
      (error: unknown) => error instanceof z.ZodError,
    );
  } finally {
    await database.close();
    await admin.pool.query(`DROP DATABASE "${name}"`);
    await admin.close();
  }
});
