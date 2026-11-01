import assert from 'node:assert/strict';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import {
  chmod,
  cp,
  link,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';
import {
  PrivateFileResumeStorage,
  ResumeUploadCancelled,
  configuredFileResumeStorage,
} from './file-storage.js';
import { ResumeStorageLimit } from './resumes.js';
import { logger } from './runtime.js';

import type { ResumeObject } from './storage.js';

/** Directory entries currently in the storage directory. */
async function stored(directory: string) {
  return readdir(directory);
}

test('cancellation fences publication and never accepts a foreign marker as success', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'careerscope-fence-'));
  const encryptionKey = randomBytes(32).toString('hex');
  const storage = new PrivateFileResumeStorage({ directory, encryptionKey });
  const body = Buffer.from('%PDF-1.7 synthetic fencing fixture');
  const object: ResumeObject = {
    ownerId: randomUUID(),
    resumeId: randomUUID(),
    sha256: createHash('sha256').update(body).digest('hex'),
    bytes: body.length,
    contentType: 'application/pdf',
  };
  try {
    await storage.initialize();

    // An installed marker cannot be replaced by a later exclusive publication.
    await storage.cancelUpload(object);
    await assert.rejects(storage.put(object, body), { code: 'EEXIST' });
    await assert.rejects(storage.recoverVersion(object), ResumeUploadCancelled);
    await storage.cancelUpload(object);
    await assert.rejects(storage.get(object, randomUUID()), ResumeUploadCancelled);

    // A 36-byte file that is not this identity's authenticated marker is not success.
    const foreign = { ...object, resumeId: randomUUID() };
    const foreignPath = join(
      directory,
      `${foreign.ownerId}_${foreign.resumeId}_${foreign.sha256}.bin`,
    );
    const impostor = Buffer.concat([Buffer.from('CSC1'), Buffer.alloc(32, 7)]);
    await writeFile(foreignPath, impostor);
    await assert.rejects(storage.cancelUpload(foreign), /metadata mismatch/);
    assert.deepEqual(await readFile(foreignPath), impostor);

    // An aborted cancellation must never destroy a readable object.
    const stored = { ...object, resumeId: randomUUID() };
    const version = await storage.put(stored, body);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(storage.cancelUpload(stored, controller.signal));
    assert.deepEqual(await storage.get(stored, version), body);
    assert.equal((await storage.inventory()).temporaries, 0);
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('physical storage capacity is enforced and abandoned temporaries are swept safely', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'careerscope-capacity-'));
  const encryptionKey = randomBytes(32).toString('hex');
  const body = Buffer.from('%PDF-1.7 synthetic capacity fixture');
  const object: ResumeObject = {
    ownerId: randomUUID(),
    resumeId: randomUUID(),
    sha256: createHash('sha256').update(body).digest('hex'),
    bytes: body.length,
    contentType: 'application/pdf',
  };
  const storage = new PrivateFileResumeStorage({ directory, encryptionKey, reserveBytes: 0 });
  const full = new PrivateFileResumeStorage({
    directory,
    encryptionKey,
    reserveBytes: Number.MAX_SAFE_INTEGER,
  });
  try {
    await storage.initialize();
    await full.initialize();

    // A volume without the reserved headroom refuses new uploads before any IO.
    await assert.rejects(full.put(object, body), ResumeStorageLimit);
    assert.equal((await stored(directory)).length, 0);
    const version = await storage.put(object, body);

    // Cancellation must still succeed when the volume is refusing writes.
    const cancellable = { ...object, resumeId: randomUUID() };
    await full.cancelUpload(cancellable);
    await assert.rejects(full.recoverVersion(cancellable), ResumeUploadCancelled);

    const abandoned = join(directory, `${randomUUID()}.pending`);
    const recent = join(directory, `${randomUUID()}.pending`);
    await writeFile(abandoned, Buffer.alloc(2048));
    await writeFile(recent, Buffer.alloc(16));
    const stale = new Date(Date.now() - 7200000);
    await utimes(abandoned, stale, stale);
    const unrelated = join(directory, 'operator-note.txt');
    await writeFile(unrelated, 'not a storage temporary');

    const inventory = await storage.inventory();
    assert.equal(inventory.objects, 2);
    assert.equal(inventory.temporaries, 2);
    assert.equal(inventory.temporaryBytes, 2064);
    assert.ok(inventory.objectBytes >= body.length);
    assert.ok(inventory.totalBytes > 0 && inventory.freeBytes > 0);
    assert.equal(inventory.belowReserve, false);
    assert.equal((await full.inventory()).belowReserve, true);

    // Only temporaries older than the threshold are removable, and never objects.
    assert.deepEqual(await storage.sweepAbandonedTemporaries({ olderThanMs: 86400000 }), {
      removed: 0,
      bytes: 0,
    });
    assert.deepEqual(await storage.sweepAbandonedTemporaries({ olderThanMs: 3600000 }), {
      removed: 1,
      bytes: 2048,
    });
    const remaining = await storage.inventory();
    assert.equal(remaining.temporaries, 1);
    assert.equal(remaining.temporaryBytes, 16);
    assert.deepEqual(await storage.get(object, version), body);
    assert.equal(await readFile(unrelated, 'utf8'), 'not a storage temporary');

    // Concurrent admissions must not both spend the same observed free space.
    const large = randomBytes(2 * 1024 * 1024);
    const envelope = large.length + 72;
    const capacityBarrier = Promise.withResolvers<number>();
    let capacityReads = 0;
    const contended = new PrivateFileResumeStorage(
      { directory, encryptionKey, reserveBytes: 1000 },
      async () => {
        capacityReads += 1;
        if (capacityReads === 2) capacityBarrier.resolve(envelope + 1000);
        return capacityBarrier.promise;
      },
    );
    await contended.initialize();
    try {
      const admissions = await Promise.allSettled(
        Array.from({ length: 2 }, () => {
          const target = {
            ...object,
            resumeId: randomUUID(),
            sha256: createHash('sha256').update(large).digest('hex'),
            bytes: large.length,
          };
          return contended.put(target, large);
        }),
      );
      assert.equal(admissions.filter((result) => result.status === 'fulfilled').length, 1);
      const refused = admissions.find((result) => result.status === 'rejected');
      assert.ok(refused?.status === 'rejected' && refused.reason instanceof ResumeStorageLimit);
      const retry = {
        ...object,
        resumeId: randomUUID(),
        bytes: large.length,
        sha256: createHash('sha256').update(large).digest('hex'),
      };
      const retryVersion = await contended.put(retry, large);
      assert.deepEqual(await contended.get(retry, retryVersion), large);
    } finally {
      contended.close();
    }

    // A failure after admission must return its reservation, not leak capacity.
    const single = randomBytes(64 * 1024);
    const singleEnvelope = single.length + 72;
    const strict = new PrivateFileResumeStorage(
      { directory, encryptionKey, reserveBytes: 0 },
      async () => singleEnvelope,
    );
    await strict.initialize();
    try {
      const blocked = {
        ...object,
        resumeId: randomUUID(),
        bytes: single.length,
        sha256: createHash('sha256').update(single).digest('hex'),
      };
      await strict.cancelUpload(blocked);
      await assert.rejects(strict.put(blocked, single), { code: 'EEXIST' });
      const afterFailure = {
        ...blocked,
        resumeId: randomUUID(),
      };
      const recoveredVersion = await strict.put(afterFailure, single);
      assert.deepEqual(await strict.get(afterFailure, recoveredVersion), single);
      // Only the deliberately retained recent fixture remains; no write leaked one.
      assert.equal((await strict.inventory()).temporaries, 1);
    } finally {
      strict.close();
    }
  } finally {
    storage.close();
    full.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('writer startup reclaims crash-stranded temporaries without touching anything else', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'careerscope-reclaim-'));
  const encryptionKey = randomBytes(32).toString('hex');
  const storage = new PrivateFileResumeStorage({ directory, encryptionKey });
  const body = Buffer.from('%PDF-1.7 synthetic reclaim fixture');
  const object: ResumeObject = {
    ownerId: randomUUID(),
    resumeId: randomUUID(),
    sha256: createHash('sha256').update(body).digest('hex'),
    bytes: body.length,
    contentType: 'application/pdf',
  };
  try {
    await storage.initialize();
    const version = await storage.put(object, body);
    const cancelled = { ...object, resumeId: randomUUID() };
    await storage.cancelUpload(cancelled);

    // A crash leaves a brand-new temporary that age-based sweeping would keep forever.
    const stranded = join(directory, `${randomUUID()}.pending`);
    await writeFile(stranded, Buffer.alloc(3072));
    const published = join(directory, `${randomUUID()}.pending`);
    await link(
      join(directory, `${object.ownerId}_${object.resumeId}_${object.sha256}.bin`),
      published,
    );
    const publishedAlias = published;
    const unrelated = join(directory, 'operator-note.txt');
    await writeFile(unrelated, 'not a storage temporary');
    assert.deepEqual(await storage.sweepAbandonedTemporaries({ olderThanMs: 0 }), {
      removed: 0,
      bytes: 0,
    });

    // Fresh temporaries may belong to a live writer, so startup reclaim keeps them.
    assert.deepEqual(await storage.reclaimTemporariesAtStartup(), { removed: 0, bytes: 0 });
    const aged = new Date(Date.now() - 11 * 60_000);
    await utimes(stranded, aged, aged);
    await utimes(published, aged, aged);

    assert.deepEqual(await storage.reclaimTemporariesAtStartup(), {
      removed: 2,
      bytes: 3072 + body.length + 72,
    });
    await assert.rejects(readFile(stranded), { code: 'ENOENT' });
    // Removing a linked alias must not remove the published object behind it.
    await assert.rejects(readFile(publishedAlias), { code: 'ENOENT' });
    assert.deepEqual(await storage.get(object, version), body);
    await assert.rejects(storage.recoverVersion(cancelled), ResumeUploadCancelled);
    assert.equal(await readFile(unrelated, 'utf8'), 'not a storage temporary');
    const inventory = await storage.inventory();
    assert.equal(inventory.objects, 2);
    // One published object plus the retained cancellation marker.
    assert.equal(inventory.markers, 1);
    assert.equal(inventory.markerBytes, 36);
    assert.equal(inventory.temporaries, 0);
    assert.equal(inventory.reservedBytes, 0);
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// Global backstop only: the per-owner limit is left at its default (100) so the shared 10,000 cap is what trips.
test('cancellation markers are retained and bounded by the global backstop', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'careerscope-markers-'));
  const encryptionKey = randomBytes(32).toString('hex');
  const body = Buffer.from('%PDF-1.7 synthetic marker quota fixture');
  const base: ResumeObject = {
    ownerId: randomUUID(),
    resumeId: randomUUID(),
    sha256: createHash('sha256').update(body).digest('hex'),
    bytes: body.length,
    contentType: 'application/pdf',
  };
  const storage = new PrivateFileResumeStorage({ directory, encryptionKey, markerLimit: 2 });
  try {
    await storage.initialize();
    const first = { ...base, resumeId: randomUUID() };
    await storage.cancelUpload(first);
    // Repeating a cancellation is idempotent and must not consume more quota.
    await storage.cancelUpload(first);
    await storage.cancelUpload({ ...base, resumeId: randomUUID() });

    const full = await storage.inventory();
    assert.equal(full.markers, 2);
    assert.equal(full.markerLimit, 2);
    assert.equal(full.markersExceeded, true);
    await assert.rejects(
      storage.cancelUpload({ ...base, resumeId: randomUUID() }),
      ResumeStorageLimit,
    );

    // Markers fence late publication forever, so no sweep may reclaim them.
    assert.deepEqual(await storage.sweepAbandonedTemporaries({ olderThanMs: 0 }), {
      removed: 0,
      bytes: 0,
    });
    assert.deepEqual(await storage.reclaimTemporariesAtStartup(), { removed: 0, bytes: 0 });
    assert.equal((await storage.inventory()).markers, 2);
    await assert.rejects(storage.recoverVersion(first), ResumeUploadCancelled);
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('one owner at the per-owner marker limit cannot cancel more while another owner can', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'careerscope-owner-markers-'));
  const encryptionKey = randomBytes(32).toString('hex');
  const { object } = fixture();
  const other = { ...object, ownerId: randomUUID() };
  const storage = new PrivateFileResumeStorage({ directory, encryptionKey, ownerMarkerLimit: 2 });
  try {
    await storage.initialize();
    const first = { ...object, resumeId: randomUUID() };
    await storage.cancelUpload(first);
    await storage.cancelUpload(first); // idempotent, consumes no quota
    await storage.cancelUpload({ ...object, resumeId: randomUUID() });
    await assert.rejects(
      storage.cancelUpload({ ...object, resumeId: randomUUID() }),
      (error: unknown) =>
        error instanceof ResumeStorageLimit &&
        !error.message.includes(object.ownerId) &&
        !error.message.includes(other.ownerId),
    );
    await storage.cancelUpload({ ...other, resumeId: randomUUID() });
    await storage.cancelUpload({ ...other, resumeId: randomUUID() });
    await assert.rejects(
      storage.cancelUpload({ ...other, resumeId: randomUUID() }),
      ResumeStorageLimit,
    );
    assert.equal((await storage.inventory()).markers, 4);
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('per-owner marker counts are rebuilt on initialize and restored after the 24-hour reclaim', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'careerscope-owner-reclaim-'));
  const encryptionKey = randomBytes(32).toString('hex');
  const { object } = fixture();
  const config = { directory, encryptionKey, ownerMarkerLimit: 2 };
  const storage = new PrivateFileResumeStorage(config);
  const restarted = new PrivateFileResumeStorage(config);
  try {
    await storage.initialize();
    const first = { ...object, resumeId: randomUUID() };
    await storage.cancelUpload(first);
    await storage.cancelUpload({ ...object, resumeId: randomUUID() });
    await assert.rejects(
      storage.cancelUpload({ ...object, resumeId: randomUUID() }),
      ResumeStorageLimit,
    );

    // A fresh process recounts the owner from disk.
    await restarted.initialize();
    await assert.rejects(
      restarted.cancelUpload({ ...object, resumeId: randomUUID() }),
      ResumeStorageLimit,
    );

    const old = new Date(Date.now() - 25 * 3_600_000);
    await utimes(
      join(directory, `${first.ownerId}_${first.resumeId}_${first.sha256}.bin`),
      old,
      old,
    );
    assert.equal(await storage.reclaimExpiredMarkers(), 1);
    await storage.cancelUpload({ ...object, resumeId: randomUUID() });
    await assert.rejects(
      storage.cancelUpload({ ...object, resumeId: randomUUID() }),
      ResumeStorageLimit,
    );
  } finally {
    storage.close();
    restarted.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a foreign 36-byte file does not count toward an owner marker quota', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'careerscope-owner-foreign-'));
  const encryptionKey = randomBytes(32).toString('hex');
  const { object } = fixture();
  const foreign = join(directory, `${object.ownerId}_${randomUUID()}_${object.sha256}.bin`);
  const storage = new PrivateFileResumeStorage({ directory, encryptionKey, ownerMarkerLimit: 1 });
  try {
    await storage.initialize(); // creates the directory
    await writeFile(foreign, Buffer.alloc(36, 7));
    await storage.initialize(); // recounts: the foreign file has no marker magic
    await storage.cancelUpload({ ...object, resumeId: randomUUID() });
    await assert.rejects(
      storage.cancelUpload({ ...object, resumeId: randomUUID() }),
      ResumeStorageLimit,
    );
    await storage.reclaimExpiredMarkers();
    await assert.rejects(
      storage.cancelUpload({ ...object, resumeId: randomUUID() }),
      ResumeStorageLimit,
    );
    assert.equal((await readFile(foreign)).length, 36);
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('genuine out-of-space failures stay typed, unpublished and release capacity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'careerscope-exhausted-'));
  const encryptionKey = randomBytes(32).toString('hex');
  const body = Buffer.from('%PDF-1.7 synthetic exhaustion fixture');
  const base: ResumeObject = {
    ownerId: randomUUID(),
    resumeId: randomUUID(),
    sha256: createHash('sha256').update(body).digest('hex'),
    bytes: body.length,
    contentType: 'application/pdf',
  };
  let failure: { code: string; stage: 'write' | 'publish' } | null = null;
  class ExhaustedStorage extends PrivateFileResumeStorage {
    protected override async writeTemporary(
      temporary: string,
      envelope: Buffer,
      signal?: AbortSignal,
    ) {
      await super.writeTemporary(temporary, envelope, signal);
      if (failure?.stage === 'write') throw Object.assign(new Error('synthetic'), failure);
    }
    protected override async publishObject(temporary: string, filename: string) {
      if (failure?.stage === 'publish') throw Object.assign(new Error('synthetic'), failure);
      await super.publishObject(temporary, filename);
    }
  }
  // Admission always passes so only the real write failure can reject the upload.
  const storage = new ExhaustedStorage(
    { directory, encryptionKey, reserveBytes: 0 },
    async () => body.length + 72,
  );
  try {
    await storage.initialize();
    for (const stage of ['write', 'publish'] as const) {
      for (const code of ['ENOSPC', 'EDQUOT', 'EFBIG']) {
        failure = { code, stage };
        const object = { ...base, resumeId: randomUUID() };
        await assert.rejects(storage.put(object, body), ResumeStorageLimit);
        // Nothing may be published, and no temporary may be stranded.
        assert.equal(await storage.recoverVersion(object), null);
        const inventory = await storage.inventory();
        assert.equal(inventory.temporaries, 0);
        assert.equal(inventory.objects, 0);
        assert.equal(inventory.reservedBytes, 0);
      }
    }
    // Every released reservation must leave the next upload admissible.
    failure = null;
    const accepted = { ...base, resumeId: randomUUID() };
    const version = await storage.put(accepted, body);
    assert.deepEqual(await storage.get(accepted, version), body);
    assert.equal((await storage.inventory()).temporaries, 0);
    assert.equal((await storage.inventory()).reservedBytes, 0);
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('private file storage encrypts immutable owned versions and restores them without overwrites', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'careerscope-files-'));
  const backup = await mkdtemp(join(tmpdir(), 'careerscope-files-restore-'));
  const encryptionKey = randomBytes(32).toString('hex');
  const storage = new PrivateFileResumeStorage({ directory, encryptionKey });
  const body = Buffer.from('%PDF-1.7 synthetic private resume TypeScript engineer');
  const object: ResumeObject = {
    ownerId: randomUUID(),
    resumeId: randomUUID(),
    sha256: createHash('sha256').update(body).digest('hex'),
    bytes: body.length,
    contentType: 'application/pdf',
  };
  try {
    await assert.rejects(storage.put(object, body), /not initialized/);
    await storage.initialize();
    assert.equal(await storage.recoverVersion(object), null);
    const writes = await Promise.allSettled(
      Array.from({ length: 8 }, () => storage.put(object, body)),
    );
    const winners = writes.filter((result) => result.status === 'fulfilled');
    assert.equal(winners.length, 1);
    const version = winners[0]!.value;
    assert.deepEqual(await storage.get(object, version), body);
    assert.equal(await storage.recoverVersion(object), version);
    assert.equal((await stored(directory)).length, 1);
    const filename = join(directory, (await stored(directory))[0]!);
    const envelope = await readFile(filename);
    assert.equal(envelope.includes(body), false);
    await assert.rejects(storage.get(object, randomUUID()), /version mismatch/);
    await assert.rejects(storage.delete(object, randomUUID()), /version mismatch/);
    await assert.rejects(storage.get({ ...object, ownerId: randomUUID() }, version), {
      code: 'ENOENT',
    });
    await assert.rejects(storage.get({ ...object, ownerId: '../escape' }, version));
    await assert.rejects(
      storage.get(
        {
          ...object,
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        },
        version,
      ),
    );
    await assert.rejects(storage.put({ ...object, resumeId: randomUUID() }, Buffer.from('wrong')));
    await assert.rejects(storage.get(object, version, AbortSignal.abort()));
    await cp(directory, backup, { recursive: true });
    const restored = new PrivateFileResumeStorage({ directory: backup, encryptionKey });
    try {
      await restored.initialize();
      assert.equal(await restored.recoverVersion(object), version);
      assert.deepEqual(await restored.get(object, version), body);
    } finally {
      restored.close();
    }
    const wrongKey = new PrivateFileResumeStorage({
      directory,
      encryptionKey: randomBytes(32).toString('hex'),
    });
    try {
      await wrongKey.initialize();
      await assert.rejects(wrongKey.get(object, version), /key mismatch/);
    } finally {
      wrongKey.close();
    }
    const tampered = Buffer.from(envelope);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
    await writeFile(filename, tampered);
    await assert.rejects(storage.get(object, version), /unable to authenticate data/);
    await assert.rejects(storage.recoverVersion(object), /unable to authenticate data/);
    await writeFile(filename, envelope);
    await storage.delete(object, version);
    await storage.delete(object, version);
    assert.equal(await storage.recoverVersion(object), null);
    assert.equal((await stored(directory)).length, 0);
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
    await rm(backup, { recursive: true, force: true });
  }
});

test('file cancellation permanently fences late publication and verifies existing objects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'careerscope-cancel-'));
  const encryptionKey = randomBytes(32).toString('hex');
  const storage = new PrivateFileResumeStorage({ directory, encryptionKey });
  const body = Buffer.from('%PDF-1.7 synthetic interrupted upload');
  const object: ResumeObject = {
    ownerId: randomUUID(),
    resumeId: randomUUID(),
    sha256: createHash('sha256').update(body).digest('hex'),
    bytes: body.length,
    contentType: 'application/pdf',
  };
  try {
    await storage.initialize();
    await storage.cancelUpload(object);
    await storage.cancelUpload(object);
    await assert.rejects(storage.put(object, body), { code: 'EEXIST' });
    await assert.rejects(storage.recoverVersion(object), ResumeUploadCancelled);
    const filename = join(directory, `${object.ownerId}_${object.resumeId}_${object.sha256}.bin`);
    const staged = join(directory, 'synthetic-paused-writer.pending');
    await writeFile(staged, body);
    await assert.rejects(link(staged, filename), { code: 'EEXIST' });
    await rm(staged);
    const restored = new PrivateFileResumeStorage({
      directory,
      encryptionKey,
    });
    try {
      await restored.initialize();
      await assert.rejects(restored.put(object, body), { code: 'EEXIST' });
      await restored.cancelUpload(object);
    } finally {
      restored.close();
    }
    const stored = { ...object, resumeId: randomUUID() };
    const version = await storage.put(stored, body);
    const cancellations = await Promise.allSettled(
      Array.from({ length: 8 }, () => storage.cancelUpload(stored)),
    );
    for (const result of cancellations) {
      if (result.status === 'rejected') throw result.reason;
    }
    await storage.cancelUpload(stored);
    await assert.rejects(storage.get(stored, version), ResumeUploadCancelled);
    await assert.rejects(storage.delete(stored, version), ResumeUploadCancelled);
    const foreign = { ...object, ownerId: randomUUID() };
    const foreignVersion = await storage.put(foreign, body);
    await storage.cancelUpload(object);
    assert.deepEqual(await storage.get(foreign, foreignVersion), body);
    const corrupt = { ...object, resumeId: randomUUID() };
    await storage.put(corrupt, body);
    const corruptPath = join(
      directory,
      `${corrupt.ownerId}_${corrupt.resumeId}_${corrupt.sha256}.bin`,
    );
    await writeFile(corruptPath, Buffer.alloc(body.length + 72));
    await assert.rejects(storage.cancelUpload(corrupt));
    assert.deepEqual(await readFile(corruptPath), Buffer.alloc(body.length + 72));
    const raced = { ...object, resumeId: randomUUID() };
    await Promise.allSettled(
      Array.from({ length: 8 }, () => storage.put(raced, body)).concat(
        storage.cancelUpload(raced).then(() => 'cancelled'),
      ),
    );
    await storage.cancelUpload(raced);
    await assert.rejects(storage.recoverVersion(raced), ResumeUploadCancelled);
    assert.equal(
      (await readdir(directory)).some((name) => name.endsWith('.pending')),
      false,
    );
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('private file storage rejects nonprivate directories and linked storage roots', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'careerscope-files-guard-'));
  const directory = join(parent, 'objects');
  const encryptionKey = randomBytes(32).toString('hex');
  const storage = new PrivateFileResumeStorage({ directory, encryptionKey });
  try {
    assert.throws(() => new PrivateFileResumeStorage({ directory: 'relative', encryptionKey }));
    assert.throws(() => new PrivateFileResumeStorage({ directory, encryptionKey: 'weak' }));
    await storage.initialize();
    const linked = join(parent, 'linked');
    await symlink(directory, linked, process.platform === 'win32' ? 'junction' : 'dir');
    const unsafe = new PrivateFileResumeStorage({ directory: linked, encryptionKey });
    try {
      await assert.rejects(unsafe.initialize(), /symbolic links/);
    } finally {
      unsafe.close();
    }
    if (process.platform !== 'win32') {
      await chmod(directory, 0o755);
      await assert.rejects(storage.initialize(), /must be private/);
    }
  } finally {
    storage.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test('a stored resume is AES-256-GCM ciphertext that is unreadable without the separate key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'careerscope-at-rest-'));
  const keyDirectory = await mkdtemp(join(tmpdir(), 'careerscope-key-'));
  const encryptionKey = randomBytes(32).toString('hex');
  const keyFile = join(keyDirectory, 'encryption.key');
  await writeFile(keyFile, encryptionKey, { mode: 0o600 });
  const marker = 'Jane Doe jane.doe@example.test +1 555 0100 TypeScript engineer';
  const body = Buffer.from(`%PDF-1.7 ${marker}`);
  const object: ResumeObject = {
    ownerId: randomUUID(),
    resumeId: randomUUID(),
    sha256: createHash('sha256').update(body).digest('hex'),
    bytes: body.length,
    contentType: 'application/pdf',
  };
  const storage = new PrivateFileResumeStorage({
    directory,
    encryptionKey,
  });
  const configured = await configuredFileResumeStorage({
    RESUME_STORAGE_DIRECTORY: directory,
    RESUME_STORAGE_KEY_FILE: keyFile,
  });
  try {
    await storage.initialize();
    const version = await storage.put(object, body);

    // On disk: an authenticated envelope, with no plaintext fragment and no key material.
    const files = await stored(directory);
    assert.equal(files.length, 1);
    assert.match(files[0]!, /\.bin$/);
    const envelope = await readFile(join(directory, files[0]!));
    assert.equal(envelope.subarray(0, 4).toString(), 'CSR2');
    assert.equal(
      envelope.length,
      body.length + 72,
      'magic + key id + version + nonce + tag + ciphertext',
    );
    for (const fragment of ['jane.doe', 'Jane Doe', '555 0100', 'TypeScript', '%PDF']) {
      assert.equal(envelope.includes(Buffer.from(fragment)), false, fragment);
    }
    assert.equal(envelope.includes(Buffer.from(encryptionKey)), false);
    assert.equal(envelope.includes(Buffer.from(encryptionKey, 'hex')), false);

    // The key lives in its own file, outside the object directory.
    assert.equal(
      files.some((name) => name.includes('key')),
      false,
    );
    assert.ok(configured, 'the key file must configure the same storage');
    assert.deepEqual(await configured.get(object, version), body);

    // Without the key, or with another key, the object cannot be opened.
    const stranger = new PrivateFileResumeStorage({
      directory,
      encryptionKey: randomBytes(32).toString('hex'),
    });
    await stranger.initialize();
    await assert.rejects(stranger.get(object, version), /key mismatch/);
    stranger.close();

    // A flipped ciphertext bit is detected, not decrypted to garbage.
    const tampered = Buffer.from(envelope);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
    await writeFile(join(directory, files[0]!), tampered);
    await assert.rejects(storage.get(object, version), /unable to authenticate data/);

    // The ciphertext is bound to its identity: copied under another resume id it does not open.
    await writeFile(join(directory, files[0]!), envelope);
    const other = { ...object, resumeId: randomUUID() };
    await writeFile(
      join(directory, `${other.ownerId}_${other.resumeId}_${other.sha256}.bin`),
      envelope,
    );
    await assert.rejects(storage.get(other, version), /unable to authenticate data/);
    assert.deepEqual(await storage.get(object, version), body);
  } finally {
    storage.close();
    configured?.close();
    await rm(directory, { recursive: true, force: true });
    await rm(keyDirectory, { recursive: true, force: true });
  }
});

test('a malformed, relative or group-readable key file is refused', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'careerscope-keycheck-'));
  try {
    const bad = join(directory, 'short.key');
    await writeFile(bad, 'not-a-key', { mode: 0o600 });
    await assert.rejects(
      configuredFileResumeStorage({
        RESUME_STORAGE_DIRECTORY: join(directory, 'objects'),
        RESUME_STORAGE_KEY_FILE: bad,
      }),
    );
    await assert.rejects(
      configuredFileResumeStorage({
        RESUME_STORAGE_DIRECTORY: 'relative',
        RESUME_STORAGE_KEY_FILE: bad,
      }),
    );
    if (process.platform !== 'win32') {
      const open = join(directory, 'open.key');
      await writeFile(open, randomBytes(32).toString('hex'), { mode: 0o644 });
      await chmod(open, 0o644);
      await assert.rejects(
        configuredFileResumeStorage({
          RESUME_STORAGE_DIRECTORY: join(directory, 'objects'),
          RESUME_STORAGE_KEY_FILE: open,
        }),
        /private/,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a temporary stamped ahead of the process clock is reclaimed only after it ages', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'careerscope-future-temp-'));
  await chmod(directory, 0o700);
  const storage = new PrivateFileResumeStorage({
    directory,
    encryptionKey: randomBytes(32).toString('hex'),
  });
  try {
    await storage.initialize();
    const stranded = join(directory, `${randomUUID()}.pending`);
    await writeFile(stranded, Buffer.alloc(512));
    const future = new Date(Date.now() + 60_000);
    await utimes(stranded, future, future);

    // A future stamp is age 0, so a live writer's file is never reclaimed.
    assert.deepEqual(await storage.reclaimTemporariesAtStartup(), { removed: 0, bytes: 0 });
    assert.equal((await readFile(stranded)).length, 512);

    // Younger than ten minutes is still kept.
    const recent = new Date(Date.now() - 9 * 60_000);
    await utimes(stranded, recent, recent);
    assert.deepEqual(await storage.reclaimTemporariesAtStartup(), { removed: 0, bytes: 0 });

    const aged = new Date(Date.now() - 11 * 60_000);
    await utimes(stranded, aged, aged);
    assert.deepEqual(await storage.reclaimTemporariesAtStartup(), { removed: 1, bytes: 512 });
    assert.deepEqual(
      (await readdir(directory)).filter((name) => name.endsWith('.pending')),
      [],
    );
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a sweep never reaches an age below the ten minute reclaim bound', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'careerscope-floor-'));
  const storage = new PrivateFileResumeStorage({
    directory,
    encryptionKey: randomBytes(32).toString('hex'),
  });
  try {
    await storage.initialize();
    const stranded = join(directory, `${randomUUID()}.pending`);
    await writeFile(stranded, Buffer.alloc(64));
    const recent = new Date(Date.now() - 9 * 60_000);
    await utimes(stranded, recent, recent);
    assert.deepEqual(await storage.sweepAbandonedTemporaries({ olderThanMs: 0 }), {
      removed: 0,
      bytes: 0,
    });
    const aged = new Date(Date.now() - 11 * 60_000);
    await utimes(stranded, aged, aged);
    assert.deepEqual(await storage.sweepAbandonedTemporaries({ olderThanMs: 0 }), {
      removed: 1,
      bytes: 64,
    });
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

class ReclaimedOnce extends PrivateFileResumeStorage {
  publishes = 0;
  failEvery = false;
  protected override async publishObject(temporary: string, filename: string) {
    this.publishes += 1;
    if (this.failEvery || this.publishes === 1) await rm(temporary);
    await super.publishObject(temporary, filename);
  }
}

test('put retries once with a fresh temporary when its temporary was reclaimed before linking', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'careerscope-retry-'));
  const body = Buffer.from('%PDF-1.7 synthetic reclaimed temporary fixture');
  const object: ResumeObject = {
    ownerId: randomUUID(),
    resumeId: randomUUID(),
    sha256: createHash('sha256').update(body).digest('hex'),
    bytes: body.length,
    contentType: 'application/pdf',
  };
  const storage = new ReclaimedOnce({ directory, encryptionKey: randomBytes(32).toString('hex') });
  try {
    await storage.initialize();
    const version = await storage.put(object, body);
    assert.equal(storage.publishes, 2);
    assert.deepEqual(await storage.get(object, version), body);
    assert.deepEqual(
      (await readdir(directory)).filter((name) => name.endsWith('.pending')),
      [],
    );

    // A second consecutive reclaim is not retried again.
    storage.failEvery = true;
    storage.publishes = 0;
    const other = { ...object, resumeId: randomUUID() };
    await assert.rejects(storage.put(other, body), { code: 'ENOENT' });
    assert.equal(storage.publishes, 2);
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('cancelUpload retries once when its temporary was reclaimed before linking', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'careerscope-cancel-retry-'));
  const body = Buffer.from('%PDF-1.7 synthetic reclaimed marker fixture');
  const object: ResumeObject = {
    ownerId: randomUUID(),
    resumeId: randomUUID(),
    sha256: createHash('sha256').update(body).digest('hex'),
    bytes: body.length,
    contentType: 'application/pdf',
  };
  const storage = new PrivateFileResumeStorage({
    directory,
    encryptionKey: randomBytes(32).toString('hex'),
  });
  try {
    await storage.initialize();
    // Simulate the reclaim by removing the temporary just before the first publish.
    type Publish = (o: ResumeObject, t: string, f: string, s?: AbortSignal) => Promise<boolean>;
    const internals = storage as unknown as { publishCancellation: Publish };
    const publish = internals.publishCancellation.bind(storage);
    let calls = 0;
    internals.publishCancellation = async (o, temporary, filename, signal) => {
      calls += 1;
      if (calls === 1) await rm(temporary);
      return publish(o, temporary, filename, signal);
    };
    await storage.cancelUpload(object);
    assert.equal(calls, 2);
    await assert.rejects(storage.recoverVersion(object), ResumeUploadCancelled);
    assert.equal((await storage.inventory()).markers, 1);

    // A second consecutive reclaim is rethrown.
    internals.publishCancellation = async (o, temporary, filename, signal) => {
      await rm(temporary);
      return publish(o, temporary, filename, signal);
    };
    await assert.rejects(storage.cancelUpload({ ...object, resumeId: randomUUID() }), {
      code: 'ENOENT',
    });
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('two writers can share a directory and startup reclaim spares the live writer temporary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'careerscope-shared-'));
  const encryptionKey = randomBytes(32).toString('hex');
  const first = new PrivateFileResumeStorage({ directory, encryptionKey });
  const second = new PrivateFileResumeStorage({ directory, encryptionKey });
  try {
    await first.initialize();
    await second.initialize();
    const live = join(directory, `${randomUUID()}.pending`);
    await writeFile(live, Buffer.alloc(16));
    assert.deepEqual(await second.reclaimTemporariesAtStartup(), { removed: 0, bytes: 0 });
    assert.equal((await readFile(live)).length, 16);
  } finally {
    first.close();
    second.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const body = Buffer.from('%PDF-1.7 synthetic maintenance fixture');
  const object: ResumeObject = {
    ownerId: randomUUID(),
    resumeId: randomUUID(),
    sha256: createHash('sha256').update(body).digest('hex'),
    bytes: body.length,
    contentType: 'application/pdf',
  };
  return { body, object };
}

const elevenMinutesAgo = () => new Date(Date.now() - 11 * 60_000);

class StalledThenReclaimed extends PrivateFileResumeStorage {
  publishes = 0;
  stalls = 1;
  protected override async publishObject(temporary: string, filename: string) {
    this.publishes += 1;
    if (this.publishes <= this.stalls) {
      // The writer stalls past the floor, and a real reclaim removes its temporary.
      const aged = elevenMinutesAgo();
      await utimes(temporary, aged, aged);
      assert.equal((await this.reclaimTemporariesAtStartup()).removed, 1);
    }
    await super.publishObject(temporary, filename);
  }
}

test('put and cancelUpload survive one real stall-then-reclaim and surface a second one', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'careerscope-stall-'));
  const storage = new StalledThenReclaimed({
    directory,
    encryptionKey: randomBytes(32).toString('hex'),
  });
  try {
    await storage.initialize();
    const { body, object } = fixture();
    const version = await storage.put(object, body);
    assert.equal(storage.publishes, 2);
    assert.deepEqual(await storage.get(object, version), body);

    storage.publishes = 0;
    storage.stalls = 2;
    await assert.rejects(storage.put({ ...object, resumeId: randomUUID() }, body), {
      code: 'ENOENT',
    });
    assert.equal(storage.publishes, 2);

    // Same for cancellation, through the real reclaim.
    type Publish = (o: ResumeObject, t: string, f: string, s?: AbortSignal) => Promise<boolean>;
    const internals = storage as unknown as { publishCancellation: Publish };
    const publish = internals.publishCancellation.bind(storage);
    let publishes = 0;
    let stalls = 1;
    internals.publishCancellation = async (o, temporary, filename, signal) => {
      publishes += 1;
      if (publishes <= stalls) {
        const aged = elevenMinutesAgo();
        await utimes(temporary, aged, aged);
        assert.equal((await storage.reclaimTemporariesAtStartup()).removed, 1);
      }
      return publish(o, temporary, filename, signal);
    };
    const cancelled = { ...object, resumeId: randomUUID() };
    await storage.cancelUpload(cancelled);
    assert.equal(publishes, 2);
    await assert.rejects(storage.recoverVersion(cancelled), ResumeUploadCancelled);

    publishes = 0;
    stalls = 2;
    await assert.rejects(storage.cancelUpload({ ...object, resumeId: randomUUID() }), {
      code: 'ENOENT',
    });
    assert.equal(publishes, 2);
    assert.deepEqual(
      (await readdir(directory)).filter((name) => name.endsWith('.pending')),
      [],
    );
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('the periodic sweep reclaims aged temporaries, spares live ones, and never throws', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'careerscope-periodic-'));
  const storage = new PrivateFileResumeStorage({
    directory,
    encryptionKey: randomBytes(32).toString('hex'),
  });
  mock.timers.enable({ apis: ['setInterval'] });
  const stops: Array<() => void> = [];
  const until = (done: () => boolean) =>
    new Promise<void>((resolve) => {
      const poll = () => (done() ? resolve() : setImmediate(poll));
      poll();
    });
  try {
    await storage.initialize();
    const aged = join(directory, `${randomUUID()}.pending`);
    const live = join(directory, `${randomUUID()}.pending`);
    await writeFile(aged, Buffer.alloc(100));
    await writeFile(live, Buffer.alloc(8));
    await utimes(aged, elevenMinutesAgo(), elevenMinutesAgo());

    const results: Array<{ removed: number; bytes: number; markersRemoved: number }> = [];
    const errors: unknown[] = [];
    const stop = storage.startReclaimSweep({
      intervalMs: 60_000,
      onResult: (result) => results.push(result),
      onError: (error) => errors.push(error),
    });
    stops.push(stop);
    mock.timers.tick(60_000);
    await until(() => results.length === 1);
    assert.deepEqual(results[0], { removed: 1, bytes: 100, markersRemoved: 0 });
    assert.equal((await readFile(live)).length, 8);
    assert.equal((await storage.inventory()).reclaimedTemporaries, 1);

    // A failing sweep is reported and does not throw; a throwing reporter is contained too.
    await rm(directory, { recursive: true, force: true });
    mock.timers.tick(60_000);
    await until(() => errors.length === 1);
    const reporter = storage.startReclaimSweep({
      intervalMs: 60_000,
      onResult: () => {
        throw new Error('reporter failure');
      },
      onError: () => {
        throw new Error('reporter failure');
      },
    });
    stops.push(reporter);
    mock.timers.tick(60_000);
    await new Promise((resolve) => setImmediate(resolve));

    // Once stopped no further sweep runs.
    stop();
    reporter();
    const before = errors.length;
    mock.timers.tick(600_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(errors.length, before);
  } finally {
    for (const stop of stops) stop();
    mock.timers.reset();
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('expired cancellation markers are reclaimed and the quota is recounted from storage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'careerscope-markers-'));
  const encryptionKey = randomBytes(32).toString('hex');
  const storage = new PrivateFileResumeStorage({ directory, encryptionKey, markerLimit: 2 });
  const other = new PrivateFileResumeStorage({ directory, encryptionKey, markerLimit: 2 });
  try {
    await storage.initialize();
    await other.initialize();
    const { object } = fixture();
    const first = { ...object, resumeId: randomUUID() };
    const second = { ...object, resumeId: randomUUID() };
    const markerPath = (o: ResumeObject) =>
      join(directory, `${o.ownerId}_${o.resumeId}_${o.sha256}.bin`);
    await storage.cancelUpload(first);
    await other.cancelUpload(second);

    // The marker made by the other process is invisible to this quota until it is recounted.
    assert.equal(await storage.reclaimExpiredMarkers(), 0);
    await assert.rejects(
      storage.cancelUpload({ ...object, resumeId: randomUUID() }),
      ResumeStorageLimit,
    );

    // A foreign 36-byte file without a marker magic is never removed, and young markers stay.
    const foreign = join(directory, `${object.ownerId}_${randomUUID()}_${object.sha256}.bin`);
    await writeFile(foreign, Buffer.alloc(36, 7));
    const old = new Date(Date.now() - 25 * 3_600_000);
    await utimes(foreign, old, old);
    await utimes(markerPath(first), old, old);

    assert.equal(await storage.reclaimExpiredMarkers(), 1);
    await assert.rejects(readFile(markerPath(first)), { code: 'ENOENT' });
    assert.equal((await readFile(foreign)).length, 36);
    await assert.rejects(other.recoverVersion(second), ResumeUploadCancelled);

    // The young marker and the foreign file still fill the quota until the foreign file goes.
    await assert.rejects(
      storage.cancelUpload({ ...object, resumeId: randomUUID() }),
      ResumeStorageLimit,
    );
    await rm(foreign);
    assert.equal(await storage.reclaimExpiredMarkers(), 0);
    await storage.cancelUpload({ ...object, resumeId: randomUUID() });
  } finally {
    storage.close();
    other.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('cancellation markers use a derived key and legacy raw-key markers still verify', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'careerscope-marker-key-'));
  const encryptionKey = randomBytes(32).toString('hex');
  const storage = new PrivateFileResumeStorage({ directory, encryptionKey });
  try {
    await storage.initialize();
    const { body, object } = fixture();
    const pathOf = (o: ResumeObject) =>
      join(directory, `${o.ownerId}_${o.resumeId}_${o.sha256}.bin`);

    // New markers are CSC2 and are not the legacy HMAC under the raw encryption key.
    await storage.cancelUpload(object);
    const current = await readFile(pathOf(object));
    assert.equal(current.length, 36);
    assert.equal(current.subarray(0, 4).toString(), 'CSC2');
    const internals = storage as unknown as { aad: (o: ResumeObject, v: string) => Buffer };
    const legacyFor = (o: ResumeObject, key = encryptionKey) =>
      Buffer.concat([
        Buffer.from('CSC1'),
        createHmac('sha256', Buffer.from(key, 'hex'))
          .update(internals.aad(o, 'cancelled'))
          .digest(),
      ]);
    assert.notDeepEqual(current.subarray(4), legacyFor(object).subarray(4));

    // A marker issued before the change keeps fencing, and cancelling again converges.
    const legacy = { ...object, resumeId: randomUUID() };
    await writeFile(pathOf(legacy), legacyFor(legacy));
    await assert.rejects(storage.recoverVersion(legacy), ResumeUploadCancelled);
    await assert.rejects(storage.get(legacy, randomUUID()), ResumeUploadCancelled);
    await assert.rejects(storage.put(legacy, body), { code: 'EEXIST' });
    await storage.cancelUpload(legacy);
    assert.deepEqual(await readFile(pathOf(legacy)), legacyFor(legacy));

    // A legacy-shaped marker made with another key, or a marker for another identity, is not ours.
    const foreign = { ...object, resumeId: randomUUID() };
    await writeFile(pathOf(foreign), legacyFor(foreign, randomBytes(32).toString('hex')));
    await assert.rejects(storage.recoverVersion(foreign), /metadata mismatch/);
    const swapped = { ...object, resumeId: randomUUID() };
    await writeFile(pathOf(swapped), current);
    await assert.rejects(storage.recoverVersion(swapped), /metadata mismatch/);

    // Legacy markers expire like current ones.
    const old = new Date(Date.now() - 25 * 3_600_000);
    await utimes(pathOf(legacy), old, old);
    assert.equal(await storage.reclaimExpiredMarkers(), 1);
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('CSR2 envelopes use a derived key, read legacy CSR1, and fail closed on tampering or moves', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'careerscope-csr2-'));
  const encryptionKey = randomBytes(32).toString('hex');
  const rawKey = Buffer.from(encryptionKey, 'hex');
  const storage = new PrivateFileResumeStorage({ directory, encryptionKey });
  const body = Buffer.from('%PDF-1.7 synthetic envelope fixture');
  const make = (): ResumeObject => ({
    ownerId: randomUUID(),
    resumeId: randomUUID(),
    sha256: createHash('sha256').update(body).digest('hex'),
    bytes: body.length,
    contentType: 'application/pdf',
  });
  const file = (o: ResumeObject) => join(directory, `${o.ownerId}_${o.resumeId}_${o.sha256}.bin`);
  const aad = (o: ResumeObject, version: string) =>
    Buffer.from(
      JSON.stringify({
        object: {
          sha256: o.sha256,
          bytes: o.bytes,
          contentType: o.contentType,
          ownerId: o.ownerId,
          resumeId: o.resumeId,
        },
        version,
      }),
    );
  try {
    await storage.initialize();

    // Round trip: CSR2 with a 4-byte key id and a 72-byte header.
    const object = make();
    const version = await storage.put(object, body);
    const envelope = await readFile(file(object));
    assert.equal(envelope.subarray(0, 4).toString(), 'CSR2');
    assert.equal(envelope.length, body.length + 72);
    assert.equal(envelope.subarray(8, 44).toString(), version);
    assert.deepEqual(await storage.get(object, version), body);
    assert.equal(await storage.recoverVersion(object), version);

    // The raw key alone cannot open a CSR2 object.
    const raw = createDecipheriv('aes-256-gcm', rawKey, envelope.subarray(44, 56));
    raw.setAAD(aad(object, version));
    raw.setAuthTag(envelope.subarray(56, 72));
    assert.throws(() => Buffer.concat([raw.update(envelope.subarray(72)), raw.final()]));
    // The derived key does (guards against the test passing for the wrong reason).
    const derived = Buffer.from(
      hkdfSync('sha256', rawKey, Buffer.alloc(0), 'careerscope:resume-storage:aes-gcm:v1', 32),
    );
    const good = createDecipheriv('aes-256-gcm', derived, envelope.subarray(44, 56));
    good.setAAD(aad(object, version));
    good.setAuthTag(envelope.subarray(56, 72));
    assert.deepEqual(Buffer.concat([good.update(envelope.subarray(72)), good.final()]), body);

    // A legacy CSR1 object written with the old formula (raw key) still decrypts.
    const legacy = make();
    const legacyVersion = randomUUID();
    const legacyNonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', rawKey, legacyNonce);
    cipher.setAAD(aad(legacy, legacyVersion));
    const ciphertext = Buffer.concat([cipher.update(body), cipher.final()]);
    const legacyEnvelope = Buffer.concat([
      Buffer.from('CSR1'),
      Buffer.from(legacyVersion),
      legacyNonce,
      cipher.getAuthTag(),
      ciphertext,
    ]);
    await writeFile(file(legacy), legacyEnvelope);
    assert.equal(legacyEnvelope.length, body.length + 68);
    assert.deepEqual(await storage.get(legacy, legacyVersion), body);
    assert.equal(await storage.recoverVersion(legacy), legacyVersion);

    // Tampering with the key id or the magic fails closed.
    const tamperedId = Buffer.from(envelope);
    tamperedId[5] = tamperedId[5]! ^ 1;
    await writeFile(file(object), tamperedId);
    await assert.rejects(storage.get(object, version), /key mismatch/);
    for (const magic of ['CSR1', 'CSR3', 'XXXX']) {
      const forged = Buffer.from(envelope);
      forged.write(magic, 0);
      await writeFile(file(object), forged);
      await assert.rejects(storage.get(object, version), /metadata mismatch/);
      await assert.rejects(storage.recoverVersion(object), /metadata mismatch/);
    }
    const relabelled = Buffer.from(legacyEnvelope);
    relabelled.write('CSR2', 0);
    await writeFile(file(legacy), relabelled);
    await assert.rejects(storage.get(legacy, legacyVersion), /metadata mismatch/);

    // A store holding a different key refuses the object at the key id.
    await writeFile(file(object), envelope);
    const stranger = new PrivateFileResumeStorage({
      directory,
      encryptionKey: randomBytes(32).toString('hex'),
    });
    await stranger.initialize();
    await assert.rejects(stranger.get(object, version), /key mismatch/);
    stranger.close();

    // AAD binding: moved to another identity, or presented under another version, it does not open.
    const moved = make();
    await writeFile(file(moved), envelope);
    await assert.rejects(storage.get(moved, version), /unable to authenticate data/);
    const otherVersion = Buffer.from(envelope);
    otherVersion.write(randomUUID(), 8);
    await writeFile(file(object), otherVersion);
    await assert.rejects(
      storage.get(object, otherVersion.subarray(8, 44).toString()),
      /unable to authenticate data/,
    );
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('initialize is idempotent: concurrent calls share one run and ready is never cleared', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'careerscope-init-'));
  const storage = new PrivateFileResumeStorage({
    directory,
    encryptionKey: randomBytes(32).toString('hex'),
  });
  try {
    const first = storage.initialize();
    const second = storage.initialize();
    assert.equal(first, second);
    await Promise.all([first, second]);
    assert.equal((await storage.inventory()).markers, 0);

    // Lazy re-initialisation of a ready store must not make it look uninitialised meanwhile.
    const again = storage.initialize();
    assert.notEqual(again, first);
    assert.equal((await storage.inventory()).markers, 0);
    assert.equal(storage.initialize(), again);
    await again;

    // A failed run is not cached: the next call starts afresh.
    const broken = new PrivateFileResumeStorage({
      directory: join(directory, 'file'),
      encryptionKey: randomBytes(32).toString('hex'),
    });
    await writeFile(join(directory, 'file'), 'not a directory');
    await assert.rejects(broken.initialize());
    await assert.rejects(broken.inventory(), /not initialized/);
    await rm(join(directory, 'file'));
    await broken.initialize();
    assert.equal((await broken.inventory()).objects, 0);
    broken.close();
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a sweep tick before the store is initialised is skipped silently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'careerscope-sweep-init-'));
  const storage = new PrivateFileResumeStorage({
    directory,
    encryptionKey: randomBytes(32).toString('hex'),
  });
  mock.timers.enable({ apis: ['setInterval'] });
  const results: unknown[] = [];
  const errors: unknown[] = [];
  const flush = () => new Promise((resolve) => setTimeout(resolve, 20));
  const stop = storage.startReclaimSweep({
    intervalMs: 60_000,
    onResult: (result) => results.push(result),
    onError: (error) => errors.push(error),
  });
  try {
    const pending = storage.initialize();
    mock.timers.tick(60_000);
    await flush();
    assert.equal(errors.length, 0);
    await pending;
    mock.timers.tick(60_000);
    for (let waited = 0; results.length < 1 && waited < 100; waited++) await flush();
    assert.equal(results.length, 1);
    assert.equal(errors.length, 0);

    // The same holds for a store that was never initialised at all.
    const idle = new PrivateFileResumeStorage({
      directory,
      encryptionKey: randomBytes(32).toString('hex'),
    });
    const idleStop = idle.startReclaimSweep({
      intervalMs: 60_000,
      onResult: (result) => results.push(result),
      onError: (error) => errors.push(error),
    });
    mock.timers.tick(60_000);
    await flush();
    idleStop();
    idle.close();
    assert.equal(errors.length, 0);
  } finally {
    stop();
    mock.timers.reset();
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('inventory counts only 36-byte files with a marker magic as markers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'careerscope-inventory-markers-'));
  const storage = new PrivateFileResumeStorage({
    directory,
    encryptionKey: randomBytes(32).toString('hex'),
  });
  try {
    await storage.initialize();
    const { object } = fixture();
    await storage.cancelUpload(object);
    const foreign = join(directory, `${object.ownerId}_${randomUUID()}_${object.sha256}.bin`);
    await writeFile(foreign, Buffer.alloc(36, 7));
    const inventory = await storage.inventory();
    assert.equal(inventory.markers, 1);
    assert.equal(inventory.markerBytes, 36);
    assert.equal(inventory.objects, 2);

    // A fresh process counts the same at start-up, so the quota is not overcounted.
    const other = new PrivateFileResumeStorage({
      directory,
      encryptionKey: randomBytes(32).toString('hex'),
      markerLimit: 2,
    });
    await other.initialize();
    await other.cancelUpload({ ...object, resumeId: randomUUID() });
    other.close();
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('an owner at the marker limit can re-cancel an upload that is already cancelled', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'careerscope-recancel-'));
  const encryptionKey = randomBytes(32).toString('hex');
  const { object } = fixture();
  const storage = new PrivateFileResumeStorage({ directory, encryptionKey, ownerMarkerLimit: 2 });
  try {
    await storage.initialize();
    const first = { ...object, resumeId: randomUUID() };
    const second = { ...object, resumeId: randomUUID() };
    await storage.cancelUpload(first);
    await storage.cancelUpload(second);
    // The owner is now at the limit: a new upload is refused, but repeating either cancel succeeds.
    await assert.rejects(
      storage.cancelUpload({ ...object, resumeId: randomUUID() }),
      ResumeStorageLimit,
    );
    await storage.cancelUpload(first);
    await storage.cancelUpload(second);
    assert.equal((await storage.inventory()).markers, 2);
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

class UnremovableTemporaries extends PrivateFileResumeStorage {
  attempts = 0;
  protected override async unlinkTemporary(temporary: string) {
    this.attempts += 1;
    await super.unlinkTemporary(temporary).catch(() => undefined);
    throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
  }
}

test('a failing temporary cleanup after a successful publish or cancel is logged, not thrown', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'careerscope-cleanup-'));
  const encryptionKey = randomBytes(32).toString('hex');
  const { body, object } = fixture();
  const storage = new UnremovableTemporaries({ directory, encryptionKey });
  const warn = mock.method(logger, 'warn', () => undefined);
  try {
    await storage.initialize();
    const version = await storage.put(object, body);
    assert.match(version, /\S/);
    assert.deepEqual(await storage.get(object, version), body);
    await storage.cancelUpload({ ...object, resumeId: randomUUID() });
    assert.equal(storage.attempts, 2);
    assert.equal(warn.mock.callCount(), 2);
    // The log carries the error name and code only, never the message or the path.
    const logged = JSON.stringify(warn.mock.calls.map((call) => call.arguments));
    assert.ok(logged.includes('EPERM'));
    assert.ok(!logged.includes(directory) && !logged.includes('operation not permitted'));
  } finally {
    warn.mock.restore();
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a refused cancellation re-counts markers from disk and succeeds once they are gone', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'careerscope-recount-'));
  const encryptionKey = randomBytes(32).toString('hex');
  const storage = new PrivateFileResumeStorage({ directory, encryptionKey, markerLimit: 2 });
  try {
    await storage.initialize();
    const { object } = fixture();
    const first = { ...object, resumeId: randomUUID() };
    const second = { ...object, resumeId: randomUUID() };
    await storage.cancelUpload(first);
    await storage.cancelUpload(second);
    await assert.rejects(
      storage.cancelUpload({ ...object, resumeId: randomUUID() }),
      ResumeStorageLimit,
    );

    // Another process's sweep removes the markers without this process seeing it. The re-count is
    // rate limited, so the test resets its timestamp rather than waiting for the window to pass.
    storage['lastMarkerRecountMs'] = 0;
    for (const o of [first, second]) {
      await rm(join(directory, `${o.ownerId}_${o.resumeId}_${o.sha256}.bin`));
    }
    await storage.cancelUpload({ ...object, resumeId: randomUUID() });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a full store still admits a fresh owner from the reserve, and no one else', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'careerscope-reserve-'));
  const encryptionKey = randomBytes(32).toString('hex');
  // markerLimit 3 gives a reserve of one slot (max(1, floor(3 / 10))).
  const storage = new PrivateFileResumeStorage({
    directory,
    encryptionKey,
    markerLimit: 3,
    ownerMarkerLimit: 2,
  });
  try {
    await storage.initialize();
    const { object } = fixture();
    const owner = (ownerId: string) => ({ ...object, ownerId, resumeId: randomUUID() });
    const heavy = randomUUID();
    const light = randomUUID();
    await storage.cancelUpload(owner(heavy));
    await storage.cancelUpload(owner(heavy));
    await storage.cancelUpload(owner(light));

    // The store is at its limit. The heavy owner is at its own cap, so it is refused.
    await assert.rejects(storage.cancelUpload(owner(heavy)), ResumeStorageLimit);
    // A fresh owner takes the one reserve slot.
    await storage.cancelUpload(owner(randomUUID()));
    // The reserve is shared, so the next fresh owner is refused.
    await assert.rejects(storage.cancelUpload(owner(randomUUID())), ResumeStorageLimit);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
