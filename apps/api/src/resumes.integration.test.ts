import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import {
  Auth,
  Database,
  ResumeUploadRepository,
  refreshCookie,
  sessionCookie,
  type ResumeObject,
} from '@careerscope/core';
import { createApp } from './app.js';

const origin = 'https://careerscope.test';
const bucket = 'synthetic-resumes';
const pdf = Buffer.from('%PDF-1.7 synthetic resume route document');
const metadata = { sha256: 'a'.repeat(64), bytes: 100, contentType: 'application/pdf' };

type Storage = NonNullable<Parameters<typeof createApp>[3]>['resumeStorage'];

/** A throwaway database with two signed-in owners, dropped when `run` finishes. */
async function withFixture(
  run: (fixture: {
    database: Database;
    uploads: ResumeUploadRepository;
    owner: { id: string; headers: Record<string, string> };
    other: { id: string; headers: Record<string, string> };
  }) => Promise<void>,
) {
  const configured = process.env.DATABASE_URL;
  assert.ok(configured, 'integration test requires an isolated DATABASE_URL');
  const url = new URL(configured);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  const admin = new Database(configured);
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  url.pathname = `/${name}`;
  const database = new Database(url.href);
  try {
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL('../../../migrations', import.meta.url)),
    });
    const auth = new Auth(database);
    const signIn = async () => {
      const id = randomUUID();
      const email = `${id}@example.test`;
      await database.pool.query('INSERT INTO users (id, email) VALUES ($1, $2)', [id, email]);
      const credentials = await auth.loginWithVerifiedEmail(email);
      assert.ok(credentials);
      const session = await auth.session(credentials.accessToken);
      assert.ok(session);
      return {
        id,
        headers: {
          origin,
          cookie: `${sessionCookie}=${credentials.accessToken}; ${refreshCookie}=${credentials.refreshToken}`,
          'x-csrf-token': session.csrf,
        },
      };
    };
    await run({
      database,
      uploads: new ResumeUploadRepository(database),
      owner: await signIn(),
      other: await signIn(),
    });
  } finally {
    await database.close();
    await admin.pool.query(`DROP DATABASE "${name}"`);
    await admin.close();
  }
}

const storageStub = (overrides: Partial<NonNullable<Storage>> = {}): NonNullable<Storage> => ({
  bucket,
  initialize: async () => {},
  put: async () => 'synthetic-version',
  get: async () => pdf,
  recoverVersion: async () => null,
  delete: async () => {},
  ...overrides,
});

test(
  'F-023: a candidate cancels only their own unfinished upload; queued and completed uploads return 409',
  { timeout: 60_000 },
  async () => {
    await withFixture(async ({ database, uploads, owner, other }) => {
      const cancelled: ResumeObject[] = [];
      const app = await createApp(database, origin, async () => true, {
        testAccess: { mode: 'disabled' },
        resumeStorage: storageStub({
          cancelUpload: async (object) => {
            cancelled.push(object);
          },
        }),
      });
      try {
        const own = await uploads.reserve(owner.id, 'cancel-own-upload', bucket, metadata);
        const cancel = (id: string, headers: Record<string, string>) =>
          app.inject({ method: 'POST', url: `/api/resumes/${id}/cancel`, headers });

        const before = (await app.inject({ url: '/api/resumes', headers: owner.headers })).json();
        assert.equal(before.cancellationEnabled, true);
        assert.deepEqual(
          before.items.map((item: { id: string; cancellable: boolean }) => [
            item.id,
            item.cancellable,
          ]),
          [[own.id, true]],
        );

        // Another owner cannot see or cancel it, and the storage is never touched.
        assert.equal((await cancel(own.id, other.headers)).statusCode, 404);
        assert.equal(cancelled.length, 0);
        assert.equal((await uploads.get(owner.id, own.id))?.status, 'uploading');

        // A crashed cancel left the row in `cancelling`; the same call finishes it.
        await database.pool.query("UPDATE resume_uploads SET status = 'cancelling' WHERE id = $1", [
          own.id,
        ]);
        const listed = (await app.inject({ url: '/api/resumes', headers: owner.headers })).json();
        assert.equal(listed.items[0].cancellable, true);

        const response = await cancel(own.id, owner.headers);
        assert.equal(response.statusCode, 200);
        assert.deepEqual(response.json(), { id: own.id, status: 'cancelled' });
        assert.equal(cancelled.length, 1);
        assert.equal(cancelled[0]?.resumeId, own.id);
        assert.equal(cancelled[0]?.ownerId, owner.id);
        // Repeating is safe and does not touch storage again.
        assert.equal((await cancel(own.id, owner.headers)).json().status, 'cancelled');
        assert.equal(cancelled.length, 1);
        const after = (await app.inject({ url: '/api/resumes', headers: owner.headers })).json();
        assert.equal(after.items[0].status, 'cancelled');
        assert.equal(after.items[0].cancellable, false);

        // A stored, queued upload has a durable parse command and is not cancellable.
        const queued = await uploads.reserve(owner.id, 'cancel-queued-upload', bucket, metadata);
        await uploads.queueStoredUpload(owner.id, queued.id, 'synthetic-version');
        const queuedResponse = await cancel(queued.id, owner.headers);
        assert.equal(queuedResponse.statusCode, 409);
        assert.equal(queuedResponse.json().code, 'UPLOAD_NOT_CANCELLABLE');
        assert.equal((await uploads.get(owner.id, queued.id))?.status, 'queued');

        // A completed upload (parse result recorded) is not cancellable either.
        await database.pool.query(
          `INSERT INTO resume_results (upload_id, owner_id, command_id, status, parsed)
           SELECT id, owner_id, command_id, 'parsed', '{"text":"x"}'::jsonb FROM resume_uploads WHERE id = $1`,
          [queued.id],
        );
        const completed = await cancel(queued.id, owner.headers);
        assert.equal(completed.statusCode, 409);
        assert.equal(completed.json().code, 'UPLOAD_NOT_CANCELLABLE');
        const final = (await app.inject({ url: '/api/resumes', headers: owner.headers })).json();
        const parsed = final.items.find((item: { id: string }) => item.id === queued.id);
        assert.equal(parsed.status, 'parsed');
        assert.equal(parsed.cancellable, false);
        assert.equal(cancelled.length, 1);

        // Unknown id for the owner is a 404, not a conflict.
        assert.equal((await cancel(randomUUID(), owner.headers)).statusCode, 404);
      } finally {
        await app.close();
      }
    });
  },
);

test(
  'F-023: without the storage cancel capability cancellation is refused and not advertised',
  { timeout: 60_000 },
  async () => {
    await withFixture(async ({ database, uploads, owner }) => {
      const app = await createApp(database, origin, async () => true, {
        testAccess: { mode: 'disabled' },
        resumeStorage: storageStub(),
      });
      try {
        const own = await uploads.reserve(owner.id, 'cancel-unavailable', bucket, metadata);
        const list = (await app.inject({ url: '/api/resumes', headers: owner.headers })).json();
        assert.equal(list.cancellationEnabled, false);
        assert.equal(list.items[0].cancellable, false);
        assert.equal(
          (
            await app.inject({
              method: 'POST',
              url: `/api/resumes/${own.id}/cancel`,
              headers: owner.headers,
            })
          ).statusCode,
          503,
        );
        assert.equal((await uploads.get(owner.id, own.id))?.status, 'uploading');
      } finally {
        await app.close();
      }
    });
  },
);

test(
  'F-021: a full per-owner budget returns 507 before storage IO and recovers when space is freed',
  { timeout: 60_000 },
  async () => {
    await withFixture(async ({ database, owner }) => {
      let storageCalls = 0;
      const app = await createApp(database, origin, async () => true, {
        testAccess: { mode: 'disabled' },
        resumeStorage: storageStub({
          put: async () => {
            storageCalls += 1;
            return 'synthetic-version';
          },
        }),
      });
      try {
        // The per-owner upload count limit is 50.
        await database.pool.query(
          `INSERT INTO resume_uploads (id, owner_id, idempotency_key, bucket, sha256, bytes, content_type)
           SELECT gen_random_uuid(), $1, 'synthetic-fill-' || series, $2, $3, 100, 'application/pdf'
           FROM generate_series(1, 50) AS series`,
          [owner.id, bucket, 'b'.repeat(64)],
        );
        const upload = (key: string) =>
          app.inject({
            method: 'POST',
            url: '/api/resumes',
            headers: {
              ...owner.headers,
              'content-type': 'application/octet-stream',
              'idempotency-key': key,
            },
            payload: pdf,
          });
        const full = await upload('over-the-limit');
        assert.equal(full.statusCode, 507);
        assert.equal(full.json().message, 'Resume storage capacity reached');
        assert.equal(storageCalls, 0);
        assert.equal(
          (await database.pool.query('SELECT count(*) FROM resume_uploads')).rows[0].count,
          '50',
        );

        await database.pool.query(
          "DELETE FROM resume_uploads WHERE idempotency_key = 'synthetic-fill-1'",
        );
        const accepted = await upload('over-the-limit');
        assert.equal(accepted.statusCode, 202);
        assert.equal(accepted.json().status, 'queued');
        assert.equal(storageCalls, 1);
      } finally {
        await app.close();
      }
    });
  },
);

test(
  'F-021: an upload that changed underneath the request returns 409',
  { timeout: 60_000 },
  async () => {
    await withFixture(async ({ database, owner }) => {
      let removeRowDuringPut = false;
      const app = await createApp(database, origin, async () => true, {
        testAccess: { mode: 'disabled' },
        resumeStorage: storageStub({
          put: async (object) => {
            if (removeRowDuringPut)
              await database.pool.query('DELETE FROM resume_uploads WHERE id = $1', [
                object.resumeId,
              ]);
            return 'synthetic-version';
          },
        }),
      });
      try {
        const upload = (key: string, payload: Buffer) =>
          app.inject({
            method: 'POST',
            url: '/api/resumes',
            headers: {
              ...owner.headers,
              'content-type': 'application/octet-stream',
              'idempotency-key': key,
            },
            payload,
          });

        // The row vanishes between storing the object and queueing it.
        removeRowDuringPut = true;
        const changed = await upload('changed-upload', pdf);
        assert.equal(changed.statusCode, 409);
        assert.equal(changed.json().message, 'Upload changed; retry');
        removeRowDuringPut = false;

        // The retry with the same key succeeds.
        const retried = await upload('changed-upload', pdf);
        assert.equal(retried.statusCode, 202);

        // The same key with different content is a conflict, not an overwrite.
        const reused = await upload('changed-upload', Buffer.from('%PDF-1.7 a different document'));
        assert.equal(reused.statusCode, 409);
        assert.equal(reused.json().code, 'IDEMPOTENCY_KEY_REUSED');
        assert.equal(
          (await database.pool.query('SELECT count(*) FROM resume_uploads')).rows[0].count,
          '1',
        );
      } finally {
        await app.close();
      }
    });
  },
);

test(
  'F-021: a client disconnect aborts the in-flight upload and leaves it recoverable',
  { timeout: 60_000 },
  async () => {
    await withFixture(async ({ database, uploads, owner }) => {
      const entered = Promise.withResolvers<void>();
      const aborted = Promise.withResolvers<void>();
      const app = await createApp(database, origin, async () => true, {
        testAccess: { mode: 'disabled' },
        resumeStorage: storageStub({
          put: async (_object, _body, signal) => {
            entered.resolve();
            await new Promise<void>((_resolve, reject) => {
              const abort = () => {
                aborted.resolve();
                reject(signal!.reason);
              };
              if (signal!.aborted) abort();
              else signal!.addEventListener('abort', abort, { once: true });
            });
            return 'unreachable';
          },
        }),
      });
      const client = new AbortController();
      try {
        const address = await app.listen({ host: '127.0.0.1', port: 0 });
        const request = fetch(`${address}/api/resumes`, {
          method: 'POST',
          headers: {
            ...owner.headers,
            'content-type': 'application/octet-stream',
            'idempotency-key': 'disconnect-upload',
          },
          body: pdf,
          signal: client.signal,
        });
        const failed = assert.rejects(request);
        await entered.promise;
        client.abort();
        await failed;
        await Promise.race([
          aborted.promise,
          new Promise((_resolve, reject) =>
            setTimeout(() => reject(new Error('storage write was not aborted')), 10_000),
          ),
        ]);
        const ids = await listIds(database, owner.id);
        assert.equal(ids.length, 1);
        assert.equal((await uploads.get(owner.id, ids[0]!))?.status, 'uploading');
        assert.equal(
          (await database.pool.query('SELECT count(*) FROM outbox_events')).rows[0].count,
          '0',
        );
      } finally {
        await app.close();
      }
    });
  },
);

async function listIds(database: Database, ownerId: string) {
  const result = await database.pool.query<{ id: string }>(
    'SELECT id FROM resume_uploads WHERE owner_id = $1',
    [ownerId],
  );
  return result.rows.map((row) => row.id);
}

test(
  'F-022: a cancelled upload can be deleted and stops counting toward the owner quota',
  { timeout: 60_000 },
  async () => {
    await withFixture(async ({ database, uploads, owner }) => {
      const app = await createApp(database, origin, async () => true, {
        testAccess: { mode: 'disabled' },
        resumeStorage: storageStub({ cancelUpload: async () => undefined }),
      });
      try {
        const upload = await uploads.reserve(owner.id, 'cancel-then-delete', bucket, metadata);
        const cancel = await app.inject({
          method: 'POST',
          url: `/api/resumes/${upload.id}/cancel`,
          headers: owner.headers,
        });
        assert.equal(cancel.statusCode, 200);

        const removed = await app.inject({
          method: 'DELETE',
          url: `/api/resumes/${upload.id}`,
          headers: owner.headers,
        });
        assert.equal(removed.statusCode, 204);
        assert.equal(await uploads.get(owner.id, upload.id), null);

        const remaining = await database.pool.query<{ count: string }>(
          'SELECT count(*) AS count FROM resume_uploads WHERE owner_id = $1',
          [owner.id],
        );
        assert.equal(remaining.rows[0]?.count, '0');
      } finally {
        await app.close();
      }
    });
  },
);
