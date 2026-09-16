import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Database } from './database.js';
import { Conflict } from './errors.js';
import { ResumeUploadCoordinator, ResumeUploadRepository, resumeParseHandler } from './resumes.js';
import { PrivateResumeStorage, maximumResumeBytes } from './storage.js';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListObjectVersionsCommand,
  PutBucketVersioningCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { localEndpoint } from './queue.js';
import JSZip from 'jszip';
import { parseResumeIsolated } from '../dist/resume-parser.js';
import { commandSchema } from './commands.js';
import { publishPending } from './dispatch.js';
import { consumeMessage, publishPending } from './dispatch.js';
import { DeleteQueueCommand } from '@aws-sdk/client-sqs';
import { localEndpoint, LocalQueue } from './queue.js';

test('resume reservations are owner-scoped and queue exactly one durable parse command atomically', async () => {
  const configured = process.env.DATABASE_URL;
  assert.ok(configured, 'Resume integration tests require local PostgreSQL');
  const url = new URL(configured);
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
  const admin = new Database(configured);
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  url.pathname = `/${name}`;
  const database = new Database(url.href);
  const uploads = new ResumeUploadRepository(database);
  const metadata = { sha256: 'a'.repeat(64), bytes: 100, contentType: 'application/pdf' };
  const bucket = 'synthetic-resumes';
  try {
    const migrationsFolder = new URL('../../../migrations', import.meta.url).pathname;
    await migrate(database.db, { migrationsFolder });
    await migrate(database.db, { migrationsFolder });
    const ownerId = randomUUID();
    const otherOwner = randomUUID();
    for (const owner of [ownerId, otherOwner]) {
      await database.pool.query(
        'INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)',
        [owner, `${owner}@example.test`, 'synthetic-not-a-login'],
      );
    }
    for (const input of [
      { ...metadata, ownerId: otherOwner },
      { ...metadata, bytes: 5242881 },
      { ...metadata, bytes: 0 },
      { ...metadata, sha256: 'invalid' },
      { ...metadata, contentType: 'text/html' },
      { ...metadata, body: 'private-text' },
    ])
      await assert.rejects(uploads.reserve(ownerId, 'invalid-upload', bucket, input));
    await assert.rejects(uploads.reserve(ownerId, 'short', bucket, metadata));
    await assert.rejects(uploads.reserve(ownerId, 'invalid-bucket', '../private', metadata));
    await assert.rejects(uploads.reserve(randomUUID(), 'unknown-owner', bucket, metadata));
    const reservations = await Promise.all(
      Array.from({ length: 8 }, () =>
        uploads.reserve(ownerId, 'same-upload-key', bucket, metadata),
      ),
    );
    assert.equal(new Set(reservations.map((record) => record.id)).size, 1);
    const reserved = reservations[0]!;
    assert.equal(reserved.status, 'uploading');
    assert.equal(reserved.objectVersion, null);
    assert.equal(reserved.commandId, null);
    assert.equal((await database.unpublished()).length, 0);
    for (const changed of [
      { ...metadata, bytes: 101 },
      { ...metadata, sha256: 'b'.repeat(64) },
    ]) {
      await assert.rejects(uploads.reserve(ownerId, 'same-upload-key', bucket, changed), Conflict);
    }
    await assert.rejects(
      uploads.reserve(ownerId, 'same-upload-key', 'another-bucket', metadata),
      Conflict,
    );
    assert.equal(await uploads.get(otherOwner, reserved.id), null);
    assert.equal(await uploads.queueStoredUpload(otherOwner, reserved.id, 'v1'), null);
    assert.notEqual(
      (await uploads.reserve(otherOwner, 'same-upload-key', bucket, metadata)).id,
      reserved.id,
    );
    for (const version of ['', 'null', 'x'.repeat(1025)]) {
      await assert.rejects(uploads.queueStoredUpload(ownerId, reserved.id, version));
    }
    await assert.rejects(
      database.pool.query("UPDATE resume_uploads SET status = 'queued' WHERE id = $1", [
        reserved.id,
      ]),
    );
    await assert.rejects(
      database.pool.query('UPDATE resume_uploads SET bytes = 0 WHERE id = $1', [reserved.id]),
    );
    const queued = await Promise.all(
      Array.from({ length: 8 }, () => uploads.queueStoredUpload(ownerId, reserved.id, 'v1')),
    );
    assert.equal(new Set(queued.map((record) => record!.commandId)).size, 1);
    assert.ok(
      queued.every((record) => record?.status === 'queued' && record.objectVersion === 'v1'),
    );
    assert.equal((await database.unpublished()).length, 1);
    const command = commandSchema.parse(await database.command(queued[0]!.commandId!));
    assert.equal(command.type, 'resume.parse');
    assert.equal(command.ownerId, ownerId);
    assert.equal(command.aggregateId, reserved.id);
    assert.equal(JSON.stringify(command).includes(metadata.sha256), false);
    assert.equal(JSON.stringify(command).includes(bucket), false);
    await assert.rejects(
      uploads.queueStoredUpload(ownerId, reserved.id, 'different-version'),
      Conflict,
    );
    assert.equal(
      (await uploads.reserve(ownerId, 'same-upload-key', bucket, metadata)).status,
      'queued',
    );

    const interrupted = await uploads.reserve(ownerId, 'interrupted-upload', bucket, metadata);
    await database.pool
      .query(`CREATE FUNCTION reject_synthetic_resume() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic outbox failure'; END $$`);
    await database.pool.query(`CREATE TRIGGER reject_synthetic_resume BEFORE INSERT ON outbox_events
      FOR EACH ROW EXECUTE FUNCTION reject_synthetic_resume()`);
    await assert.rejects(
      uploads.queueStoredUpload(ownerId, interrupted.id, 'v2'),
      /synthetic outbox failure/,
    );
    assert.equal((await uploads.get(ownerId, interrupted.id))?.status, 'uploading');
    assert.equal((await uploads.get(ownerId, interrupted.id))?.objectVersion, null);
    assert.equal((await database.unpublished()).length, 1);
    await database.pool.query('DROP TRIGGER reject_synthetic_resume ON outbox_events');
    await database.pool
      .query(`CREATE TRIGGER reject_synthetic_resume BEFORE UPDATE ON resume_uploads
      FOR EACH ROW EXECUTE FUNCTION reject_synthetic_resume()`);
    await assert.rejects(
      uploads.queueStoredUpload(ownerId, interrupted.id, 'v2'),
      /synthetic outbox failure/,
    );
    assert.equal((await uploads.get(ownerId, interrupted.id))?.status, 'uploading');
    assert.equal((await database.unpublished()).length, 1);
    await database.pool.query('DROP TRIGGER reject_synthetic_resume ON resume_uploads');
    assert.equal(
      (await uploads.queueStoredUpload(ownerId, interrupted.id, 'v2'))?.status,
      'queued',
    );
    assert.equal((await database.unpublished()).length, 2);
    for (let index = 0; index < 21; index += 1) {
      const pending = await uploads.reserve(ownerId, `pending-resume-${index}`, bucket, metadata);
      await uploads.queueStoredUpload(ownerId, pending.id, 'synthetic-version');
    }
    const search = await database.createSearch(ownerId, 'search-after-resumes', {
      query: 'React',
      sources: ['remoteok'],
    });
    const delivered: string[] = [];
    assert.equal(
      await publishPending(database, {
        'search.collect': {
          async send(command) {
            delivered.push(command.aggregateId);
          },
        },
      }),
      1,
    );
    assert.deepEqual(delivered, [search.id]);
    assert.equal(await publishPending(database, {}), 0);
    assert.equal((await database.unpublished(['resume.parse'])).length, 20);
    assert.equal((await database.unpublished(['search.collect'])).length, 0);
    assert.equal(
      (await database.pool.query('SELECT COUNT(*)::int AS count FROM candidate_profiles')).rows[0]
        .count,
      0,
    );
    const endpoint = localEndpoint(process.env.LOCAL_AWS_ENDPOINT!);
    const objectBucket = `test-coordinator-${randomUUID()}`;
    const client = new S3Client({
      endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: 'local', secretAccessKey: 'local-synthetic-secret' },
      maxAttempts: 1,
    });
    const options = () => ({ abortSignal: AbortSignal.timeout(10_000) });
    const storage = new PrivateResumeStorage({
      S3_ENDPOINT: endpoint,
      S3_BUCKET: objectBucket,
      S3_ACCESS_KEY: 'local',
      S3_SECRET_KEY: 'local-synthetic-secret',
    });
    await client.send(new CreateBucketCommand({ Bucket: objectBucket }), options());
    try {
      await client.send(
        new PutBucketVersioningCommand({
          Bucket: objectBucket,
          VersioningConfiguration: { Status: 'Enabled' },
        }),
        options(),
      );
      const coordinator = new ResumeUploadCoordinator(uploads, storage);
      const data = Buffer.from('%PDF-1.7\nSynthetic quarantine fixture, not a parser fixture');
      const before = (
        await database.pool.query('SELECT COUNT(*)::int AS count FROM resume_uploads')
      ).rows[0].count;
      for (const bytes of [
        Buffer.alloc(0),
        Buffer.alloc(maximumResumeBytes + 1),
        Buffer.from('<html>not a resume</html>'),
      ]) {
        await assert.rejects(coordinator.upload(ownerId, 'invalid-coordinator', bytes));
      }
      const aborted = AbortSignal.abort();
      await assert.rejects(coordinator.upload(ownerId, 'cancelled-coordinator', data, aborted));
      assert.equal(
        (await database.pool.query('SELECT COUNT(*)::int AS count FROM resume_uploads')).rows[0]
          .count,
        before,
      );
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          coordinator.upload(ownerId, 'concurrent-coordinator', data),
        ),
      );
      assert.equal(new Set(results.map((record) => record?.commandId)).size, 1);
      const completed = results[0]!;
      assert.equal(completed.status, 'queued');
      assert.equal(completed.sha256, createHash('sha256').update(data).digest('hex'));
      assert.equal(completed.bytes, data.length);
      assert.equal(completed.contentType, 'application/pdf');
      assert.equal(
        (await coordinator.upload(ownerId, 'concurrent-coordinator', data))?.commandId,
        completed.commandId,
      );
      await assert.rejects(
        coordinator.upload(
          ownerId,
          'concurrent-coordinator',
          Buffer.concat([data, Buffer.from('changed')]),
        ),
        Conflict,
      );
      assert.equal(await coordinator.reconcile(otherOwner, completed.id), null);
      const versions = await client.send(
        new ListObjectVersionsCommand({ Bucket: objectBucket }),
        options(),
      );
      assert.equal(versions.Versions?.length, 1);

      let puts = 0;
      const lostResponse = new ResumeUploadCoordinator(uploads, {
        bucket: objectBucket,
        initialize: storage.initialize.bind(storage),
        get: storage.get.bind(storage),
        recoverVersion: storage.recoverVersion.bind(storage),
        async put(object, bytes, signal) {
          puts += 1;
          await storage.put(object, bytes, signal);
          throw new Error('Synthetic response lost after S3 committed');
        },
      });
      assert.equal(
        (await lostResponse.upload(ownerId, 'lost-response-upload', data))?.status,
        'queued',
      );
      assert.equal(puts, 1);

      await database.pool
        .query(`CREATE TRIGGER reject_synthetic_resume BEFORE INSERT ON outbox_events
        FOR EACH ROW EXECUTE FUNCTION reject_synthetic_resume()`);
      await assert.rejects(
        coordinator.upload(ownerId, 'sql-failure-upload', data),
        /synthetic outbox failure/,
      );
      const pending = await uploads.reserve(ownerId, 'sql-failure-upload', objectBucket, {
        sha256: completed.sha256,
        bytes: data.length,
        contentType: 'application/pdf',
      });
      assert.equal(pending.status, 'uploading');
      await database.pool.query('DROP TRIGGER reject_synthetic_resume ON outbox_events');
      const resumed = await coordinator.reconcile(ownerId, pending.id);
      assert.equal(resumed?.status, 'queued');
      assert.equal(
        (await coordinator.reconcile(ownerId, pending.id))?.commandId,
        resumed?.commandId,
      );
      const absent = await uploads.reserve(ownerId, 'absent-object-upload', objectBucket, {
        sha256: completed.sha256,
        bytes: data.length,
        contentType: 'application/pdf',
      });
      assert.equal((await coordinator.reconcile(ownerId, absent.id))?.status, 'uploading');
      assert.equal(await coordinator.reconcile(otherOwner, absent.id), null);
      await assert.rejects(coordinator.reconcile(ownerId, absent.id, aborted));
      const mismatched = await uploads.reserve(
        ownerId,
        'different-storage-upload',
        'different-bucket',
        metadata,
      );
      await assert.rejects(coordinator.reconcile(ownerId, mismatched.id), Conflict);
      const after = await client.send(
        new ListObjectVersionsCommand({ Bucket: objectBucket }),
        options(),
      );
      assert.equal(after.Versions?.length, 3, 'Recovery must not create another object version');
      const parseCommands = await database.pool.query(
        "SELECT count(*)::int AS count FROM outbox_events WHERE command->>'aggregateId' = ANY($1::text[])",
        [[completed.id, resumed!.id, absent.id]],
      );
      assert.equal(parseCommands.rows[0].count, 2);
      const parseCommand = commandSchema.parse(await database.command(completed.commandId!));
      const firstFence = await database.claim(parseCommand.id);
      assert.ok(firstFence);
      await database.release(parseCommand.id, firstFence);
      const currentFence = await database.claim(parseCommand.id);
      assert.ok(currentFence && currentFence > firstFence);
      assert.equal(
        await uploads.settleParse(parseCommand, firstFence, {
          status: 'rejected',
          errorCode: 'invalid_document',
        }),
        false,
      );
      assert.equal(
        await uploads.settleParse({ ...parseCommand, ownerId: otherOwner }, currentFence, {
          status: 'rejected',
          errorCode: 'invalid_document',
        }),
        false,
      );
      assert.equal(await uploads.result(ownerId, completed.id), null);
      const handler = resumeParseHandler(database, storage);
      await assert.rejects(
        handler(
          { ...parseCommand, ownerId: otherOwner },
          currentFence,
          new AbortController().signal,
        ),
        Conflict,
      );
      await database.pool
        .query(`CREATE TRIGGER reject_synthetic_resume BEFORE INSERT ON resume_results
        FOR EACH ROW EXECUTE FUNCTION reject_synthetic_resume()`);
      await assert.rejects(
        handler(parseCommand, currentFence, new AbortController().signal),
        /synthetic outbox failure/,
      );
      assert.equal(await database.executionStatus(parseCommand.id), 'running');
      assert.equal(await uploads.result(ownerId, completed.id), null);
      await database.pool.query('DROP TRIGGER reject_synthetic_resume ON resume_results');
      assert.equal(await handler(parseCommand, currentFence, new AbortController().signal), true);
      assert.deepEqual(await uploads.result(ownerId, completed.id), {
        status: 'rejected',
        errorCode: 'invalid_document',
      });
      assert.equal(await uploads.result(otherOwner, completed.id), null);
      assert.equal(await database.executionStatus(parseCommand.id), 'completed');
      assert.equal(
        await uploads.settleParse(parseCommand, currentFence, {
          status: 'rejected',
          errorCode: 'processing_failed',
        }),
        false,
      );

      const document = new JSZip();
      document.file(
        '[Content_Types].xml',
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      );
      document.file(
        'word/document.xml',
        '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic Candidate, React and TypeScript developer with experience building accessible web applications.</w:t></w:r></w:p></w:body></w:document>',
      );
      const documentUpload = await coordinator.upload(
        ownerId,
        'full-document-workflow',
        await document.generateAsync({ type: 'nodebuffer' }),
      );
      const documentCommand = commandSchema.parse(
        await database.command(documentUpload!.commandId!),
      );
      const documentFence = await database.claim(documentCommand.id);
      assert.ok(documentFence);
      assert.equal(
        await handler(documentCommand, documentFence, new AbortController().signal),
        true,
      );
      const parsedResult = await uploads.result(ownerId, documentUpload!.id);
      assert.equal(parsedResult?.status, 'parsed');
      assert.ok(
        parsedResult?.status === 'parsed' &&
          parsedResult.parsed.derived.techStack.includes('React'),
      );
      assert.equal(
        (await database.pool.query('SELECT COUNT(*)::int AS count FROM candidate_profiles')).rows[0]
          .count,
        0,
        'Parsing must not apply unreviewed facts',
      );

      const failedCommand = commandSchema.parse(await database.command(resumed!.commandId!));
      const failedFence = await database.claim(failedCommand.id);
      assert.ok(failedFence);
      assert.equal(
        await uploads.settleParse(failedCommand, failedFence, {
          status: 'rejected',
          errorCode: 'processing_failed',
        }),
        true,
      );
      assert.equal(await database.executionStatus(failedCommand.id), 'failed');
      assert.deepEqual(await uploads.result(ownerId, resumed!.id), {
        status: 'rejected',
        errorCode: 'processing_failed',
      });
      await assert.rejects(
        database.pool.query('UPDATE resume_results SET owner_id = $1 WHERE upload_id = $2', [
          otherOwner,
          documentUpload!.id,
        ]),
      );
      await assert.rejects(
        database.pool.query(
          "UPDATE resume_results SET error_code = 'private internal diagnostic' WHERE upload_id = $1",
          [completed.id],
        ),
      );
      const queue = new LocalQueue(endpoint);
      try {
        await queue.initialize(`test-resume-${randomUUID()}`);
        const fail = (command: Parameters<typeof uploads.settleParse>[0], fence: number) =>
          uploads.settleParse(command, fence, {
            status: 'rejected',
            errorCode: 'processing_failed',
          });
        const delivered = await coordinator.upload(
          ownerId,
          'queue-delivery-upload',
          await document.generateAsync({ type: 'nodebuffer' }),
        );
        const deliveredCommand = commandSchema.parse(await database.command(delivered!.commandId!));
        await queue.send(deliveredCommand);
        const message = await queue.receive(undefined, 0);
        assert.ok(message);
        assert.equal(
          await consumeMessage(
            database,
            queue,
            message,
            'resume.parse',
            handler,
            new AbortController().signal,
            fail,
          ),
          'completed',
        );
        assert.equal((await uploads.result(ownerId, delivered!.id))?.status, 'parsed');
        await queue.send(deliveredCommand);
        const duplicate = await queue.receive(undefined, 0);
        assert.ok(duplicate);
        assert.equal(
          await consumeMessage(
            database,
            queue,
            duplicate,
            'resume.parse',
            async () => {
              throw new Error('Must not parse duplicate');
            },
            new AbortController().signal,
            fail,
          ),
          'duplicate',
        );
        const exhausted = await coordinator.upload(ownerId, 'queue-exhausted-upload', data);
        const exhaustedCommand = commandSchema.parse(await database.command(exhausted!.commandId!));
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const lease = await database.claim(exhaustedCommand.id);
          assert.ok(lease);
          await database.release(exhaustedCommand.id, lease);
        }
        await queue.send(exhaustedCommand);
        const lastAttempt = await queue.receive(undefined, 0);
        assert.ok(lastAttempt);
        await assert.rejects(
          consumeMessage(
            database,
            queue,
            lastAttempt,
            'resume.parse',
            async () => {
              throw new Error('Synthetic worker failure');
            },
            new AbortController().signal,
            fail,
          ),
          /Synthetic worker failure/,
        );
        assert.equal(await database.executionStatus(exhaustedCommand.id), 'failed');
        assert.deepEqual(await uploads.result(ownerId, exhausted!.id), {
          status: 'rejected',
          errorCode: 'processing_failed',
        });
        assert.equal(
          (
            await database.pool.query(
              'SELECT status FROM search_runs WHERE id = $1 AND owner_id = $2',
              [search.id, ownerId],
            )
          ).rows[0].status,
          'queued',
          'Resume failure must not mutate a search',
        );
      } finally {
        try {
          for (const url of [queue.url, queue.deadLetterUrl].filter(Boolean))
            await queue.client.send(new DeleteQueueCommand({ QueueUrl: url }), options());
        } finally {
          queue.close();
        }
      }
    } finally {
      storage.close();
      try {
        const remaining = await client.send(
          new ListObjectVersionsCommand({ Bucket: objectBucket }),
          options(),
        );
        for (const entry of [...(remaining.Versions ?? []), ...(remaining.DeleteMarkers ?? [])]) {
          await client.send(
            new DeleteObjectCommand({
              Bucket: objectBucket,
              Key: entry.Key,
              VersionId: entry.VersionId,
            }),
            options(),
          );
        }
        await client.send(new DeleteBucketCommand({ Bucket: objectBucket }), options());
      } finally {
        client.destroy();
      }
    }
  } finally {
    await database.close();
    await admin.pool.query(`DROP DATABASE "${name}"`);
    await admin.close();
  }
});

test('isolated parser accepts synthetic documents and rejects unsafe or excessive input', async (context) => {
  const text =
    'Synthetic Candidate, React and TypeScript developer with experience building accessible web applications.';
  const now = Date.UTC(2026, 8, 15);
  const archive = new JSZip();
  archive.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  archive.file(
    'word/document.xml',
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
  );
  const docx = await archive.generateAsync({ type: 'nodebuffer' });
  const result = await parseResumeIsolated(docx, now);
  assert.equal(result.format, 'docx');
  assert.equal(result.text, text);
  assert.ok(result.derived.techStack.includes('React'));
  context.diagnostic('Restricted DOCX extraction passed');
  await assert.rejects(parseResumeIsolated(Buffer.from('%PDF-corrupt'), now), /rejected/);
  await assert.rejects(parseResumeIsolated(Buffer.alloc(maximumResumeBytes + 1), now), /size/);
  await assert.rejects(parseResumeIsolated(docx, now, AbortSignal.abort()));
  const controller = new AbortController();
  const cancelled = parseResumeIsolated(docx, now, controller.signal);
  await assert.rejects(parseResumeIsolated(docx, now), /busy/);
  controller.abort();
  await assert.rejects(cancelled, /cancelled/);
  assert.equal((await parseResumeIsolated(docx, now)).text, text);
  archive.file('word/vbaProject.bin', 'synthetic macro placeholder');
  await assert.rejects(
    parseResumeIsolated(await archive.generateAsync({ type: 'nodebuffer' }), now),
    /rejected/,
  );
  archive.remove('word/vbaProject.bin');
  archive.file('word/large.xml', 'a'.repeat(1024 * 1024));
  await assert.rejects(
    parseResumeIsolated(
      await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
      now,
    ),
    /rejected/,
  );
  archive.remove('word/large.xml');
  for (let index = 0; index < 201; index += 1) archive.file(`word/item-${index}.xml`, 'small');
  await assert.rejects(
    parseResumeIsolated(await archive.generateAsync({ type: 'nodebuffer' }), now),
    /rejected/,
  );

  const pdfFixture = (pages: number) => {
    const pageIds = Array.from({ length: pages }, (_, index) => index + 3);
    const fontId = pages + 3;
    const contentId = pages + 4;
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages} >>`,
      ...pageIds.map(
        () =>
          `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
      ),
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    const content = `BT /F1 10 Tf 40 740 Td (${text}) Tj ET`;
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    objects.forEach((object, index) => {
      offsets.push(Buffer.byteLength(pdf));
      pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    });
    const crossReference = Buffer.byteLength(pdf);
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    pdf += offsets
      .slice(1)
      .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
      .join('');
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${crossReference}\n%%EOF`;
    return Buffer.from(pdf);
  };
  const parsedPdf = await parseResumeIsolated(pdfFixture(1), now);
  assert.equal(parsedPdf.format, 'pdf');
  assert.ok(parsedPdf.text.includes('Synthetic Candidate'));
  await assert.rejects(parseResumeIsolated(pdfFixture(51), now), /rejected/);
});
