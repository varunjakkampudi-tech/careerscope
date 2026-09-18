import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import {
  Auth,
  Database,
  LeadRepository,
  ProfileRepository,
  PrivateFileResumeStorage,
  ResumeUploadCoordinator,
  ResumeUploadRepository,
  resumeParseHandler,
  parseResumeIsolated,
} from '@careerscope/core';

async function fingerprint(database: Database) {
  const tables = await database.pool.query<{ schemaname: string; tablename: string }>(
    "SELECT schemaname, tablename FROM pg_tables WHERE schemaname IN ('public', 'drizzle') ORDER BY schemaname, tablename",
  );
  const result: Record<string, { count: number; sha256: string }> = {};
  for (const { schemaname, tablename } of tables.rows) {
    assert.match(schemaname, /^[a-z_]+$/);
    assert.match(tablename, /^[a-z_]+$/);
    const rows = await database.pool.query<{ document: string }>(
      `SELECT to_jsonb(record)::text AS document FROM "${schemaname}"."${tablename}" record ORDER BY to_jsonb(record)::text COLLATE "C"`,
    );
    result[`${schemaname}.${tablename}`] = {
      count: rows.rowCount ?? 0,
      sha256: createHash('sha256').update(JSON.stringify(rows.rows)).digest('hex'),
    };
  }
  return result;
}

test(
  'synthetic PostgreSQL backup restores auth, profiles, leads and durable pending work in a fresh container',
  { timeout: 120000 },
  async () => {
    const configured = process.env.DATABASE_URL;
    assert.ok(
      configured,
      'Recovery verification requires the dedicated local V2 database service.',
    );
    const sourceUrl = new URL(configured);
    assert.ok(['localhost', '127.0.0.1'].includes(sourceUrl.hostname));
    const sourceContainer = process.env.V2_POSTGRES_CONTAINER ?? 'careerscope-v2-postgres-1';
    assert.match(sourceContainer, /^careerscope-v2[-a-z0-9]*$/);
    const sourceName = `test_recovery_${randomUUID().replaceAll('-', '')}`;
    const restoredContainer = `careerscope-recovery-${randomUUID()}`;
    const admin = new Database(configured);
    let source: Database | undefined;
    let restored: Database | undefined;
    let sourceCreated = false;
    let containerCreated = false;
    const restorePassword = randomBytes(32).toString('hex');
    const resumeDirectory = await mkdtemp(join(tmpdir(), 'careerscope-recovery-files-'));
    const encryptionKey = randomBytes(32).toString('hex');
    const sourceStorage = new PrivateFileResumeStorage({
      directory: join(resumeDirectory, 'source'),
      encryptionKey,
    });
    const restoredStorage = new PrivateFileResumeStorage({
      directory: join(resumeDirectory, 'restored'),
      encryptionKey,
    });
    const docker = (args: string[]) =>
      execFileSync('docker', args, {
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, POSTGRES_PASSWORD: restorePassword },
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    try {
      await admin.pool.query(`CREATE DATABASE "${sourceName}"`);
      sourceCreated = true;
      sourceUrl.pathname = `/${sourceName}`;
      source = new Database(sourceUrl.href);
      await migrate(source.db, {
        migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
      });
      const auth = new Auth(source);
      const email = 'recovery@example.test';
      const password = randomBytes(24).toString('hex');
      await auth.createOwner(email, password);
      const sessionToken = await auth.login(email, password);
      assert.ok(sessionToken);
      const session = await auth.session(sessionToken);
      assert.ok(session);
      const owner = session.ownerId;
      const profile = await new ProfileRepository(source).save(owner, {
        revision: 0,
        profile: {
          candidate: {
            fullName: 'Synthetic Recovery',
            email: 'recovery@example.test',
            location: 'Hyderabad',
          },
          preferences: { titles: ['Engineer'], techStack: ['TypeScript'] },
          application: {},
        },
      });
      const run = await source.createSearch(owner, 'recovery-completed', {
        query: 'Synthetic',
        sources: ['remoteok'],
      });
      const command = (await source.unpublished())[0]!.command;
      const fence = await source.claim(command.id);
      assert.ok(fence);
      await source.completeCollection(
        command,
        fence,
        [
          {
            fingerprint: 'recovery-fixture',
            title: 'Synthetic Engineer',
            company: 'Synthetic Company',
            location: 'Remote',
            description: 'Synthetic recovery test, no provider request.',
            source: 'remoteok',
            sourceUrl: 'https://example.test/job',
            applyUrl: 'https://example.test/apply',
            postedAt: null,
          },
        ],
        [{ source: 'remoteok', status: 'completed', accepted: 1, limited: false, errorCode: null }],
      );
      const job = await source.pool.query<{ id: string }>(
        'SELECT id FROM search_jobs WHERE run_id = $1',
        [run.id],
      );
      const leads = new LeadRepository(source);
      const saved = await leads.save(owner, { jobId: job.rows[0]!.id });
      assert.ok(saved);
      const updated = await leads.update(owner, saved.id, {
        revision: saved.revision,
        notes: 'Synthetic preserved note',
        status: 'archived',
      });
      assert.ok(updated);
      await sourceStorage.initialize();
      const archive = new JSZip();
      archive.file(
        '[Content_Types].xml',
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      );
      archive.file(
        'word/document.xml',
        '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic Recovery, React and TypeScript developer building accessible web applications.</w:t></w:r></w:p></w:body></w:document>',
      );
      const resumeBody = await archive.generateAsync({ type: 'nodebuffer' });
      const sourceUploads = new ResumeUploadRepository(source);
      const resume = await new ResumeUploadCoordinator(sourceUploads, sourceStorage).upload(
        owner,
        'recovery-resume',
        resumeBody,
      );
      assert.ok(resume?.commandId);
      const resumeCommand = await source.command(resume.commandId);
      assert.ok(resumeCommand);
      const resumeFence = await source.claim(resumeCommand.id);
      assert.ok(resumeFence);
      assert.equal(
        await resumeParseHandler(source, sourceStorage)(
          resumeCommand,
          resumeFence,
          new AbortController().signal,
        ),
        true,
      );
      const parsedBefore = await sourceUploads.result(owner, resume.id);
      assert.equal(parsedBefore?.status, 'parsed');
      const queued = await source.createSearch(owner, 'recovery-pending', {
        query: 'Synthetic pending',
        sources: ['remoteok'],
      });
      const pendingBefore = await source.unpublished();
      const before = await fingerprint(source);
      const dump = execFileSync(
        'docker',
        [
          'exec',
          sourceContainer,
          'pg_dump',
          '-U',
          decodeURIComponent(sourceUrl.username),
          '-d',
          sourceName,
          '--format=custom',
          '--no-owner',
          '--no-privileges',
        ],
        {
          timeout: 30000,
          maxBuffer: 16 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      assert.equal(dump.subarray(0, 5).toString(), 'PGDMP');
      await cp(join(resumeDirectory, 'source'), join(resumeDirectory, 'restored'), {
        recursive: true,
      });
      docker([
        'run',
        '-d',
        '--name',
        restoredContainer,
        '--label',
        'careerscope.test=database-recovery',
        '--memory',
        '512m',
        '--cpus',
        '1',
        '--pids-limit',
        '256',
        '--security-opt',
        'no-new-privileges:true',
        '-p',
        '127.0.0.1::5432',
        '--tmpfs',
        '/var/lib/postgresql/data:rw,size=256m',
        '-e',
        'POSTGRES_USER=careerscope',
        '-e',
        'POSTGRES_DB=careerscope',
        '-e',
        'POSTGRES_PASSWORD',
        'postgres:17.6-alpine',
      ]);
      containerCreated = true;
      const binding = docker(['port', restoredContainer, '5432/tcp']);
      assert.match(binding, /^127\.0\.0\.1:\d+$/);
      restored = new Database(`postgresql://careerscope:${restorePassword}@${binding}/careerscope`);
      const deadline = Date.now() + 30000;
      for (;;) {
        try {
          await restored.pool.query('SELECT 1');
          break;
        } catch {
          assert.ok(Date.now() < deadline, 'Isolated recovery database startup timed out.');
          await delay(100);
        }
      }
      const restore = spawnSync(
        'docker',
        [
          'exec',
          '-i',
          restoredContainer,
          'pg_restore',
          '-U',
          'careerscope',
          '-d',
          'careerscope',
          '--no-owner',
          '--no-privileges',
          '--exit-on-error',
        ],
        { input: dump, timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      assert.equal(restore.status, 0, 'pg_restore must complete without ignored errors.');
      assert.deepEqual(await fingerprint(restored), before);
      assert.deepEqual(await fingerprint(source), before);
      await restoredStorage.initialize();
      const recoveredResume = await new ResumeUploadRepository(restored).get(owner, resume.id);
      assert.ok(recoveredResume?.objectVersion);
      const object = {
        ownerId: owner,
        resumeId: resume.id,
        sha256: recoveredResume.sha256,
        bytes: recoveredResume.bytes,
        contentType: recoveredResume.contentType,
      };
      assert.equal(await restoredStorage.recoverVersion(object), recoveredResume.objectVersion);
      const recoveredBytes = await restoredStorage.get(object, recoveredResume.objectVersion);
      assert.deepEqual(recoveredBytes, resumeBody);
      assert.deepEqual(
        await new ResumeUploadRepository(restored).result(owner, resume.id),
        parsedBefore,
      );
      assert.equal(
        (await parseResumeIsolated(recoveredBytes, recoveredResume.createdAt.getTime())).format,
        'docx',
      );
      const restoredAuth = new Auth(restored);
      assert.deepEqual(await restoredAuth.session(sessionToken), session);
      assert.ok(await restoredAuth.login(email, password));
      assert.equal(await restoredAuth.login(email, 'incorrect synthetic password'), null);
      assert.deepEqual(await new ProfileRepository(restored).get(owner), profile);
      assert.deepEqual(await new LeadRepository(restored).get(owner, saved.id), updated);
      assert.equal(await new LeadRepository(restored).get(randomUUID(), saved.id), null);
      assert.equal((await restored.getSearch(owner, run.id))?.status, 'completed');
      assert.equal((await restored.getSearch(owner, queued.id))?.status, 'queued');
      assert.deepEqual(await restored.unpublished(), pendingBefore);
      assert.ok(
        await restored.claim(
          pendingBefore.find((entry) => entry.command.aggregateId === queued.id)!.command.id,
        ),
      );
      console.log(
        JSON.stringify({
          databaseRestore: 'passed',
          tablesCompared: Object.keys(before).length,
          dumpSha256: createHash('sha256').update(dump).digest('hex'),
          ownerDataUsed: false,
          objectRecovery: 'encrypted filesystem version and parsed result restored',
        }),
      );
    } finally {
      sourceStorage.close();
      restoredStorage.close();
      await rm(resumeDirectory, { recursive: true, force: true });
      await restored?.close();
      await source?.close();
      if (containerCreated) docker(['rm', '-f', restoredContainer]);
      try {
        if (sourceCreated) await admin.pool.query(`DROP DATABASE "${sourceName}"`);
      } finally {
        await admin.close();
      }
    }
  },
);
