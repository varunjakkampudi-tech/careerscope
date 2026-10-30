import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
import test from 'node:test';
import {
  PrivateFileResumeStorage,
  ResumeUploadCancelled,
  configuredFileResumeStorage,
} from './file-storage.js';
import { ResumeStorageLimit } from './resumes.js';

/** Directory entries other than the single-writer lock file. */
async function stored(directory: string) {
  return (await readdir(directory)).filter((name) => name !== '.writer.lock');
}
import type { ResumeObject } from './storage.js';

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
    allowSharedWriters: true,
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
    const envelope = large.length + 68;
    const capacityBarrier = Promise.withResolvers<number>();
    let capacityReads = 0;
    const contended = new PrivateFileResumeStorage(
      { directory, encryptionKey, reserveBytes: 1000, allowSharedWriters: true },
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
    const singleEnvelope = single.length + 68;
    const strict = new PrivateFileResumeStorage(
      { directory, encryptionKey, reserveBytes: 0, allowSharedWriters: true },
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

    assert.deepEqual(await storage.reclaimTemporariesAtStartup(), {
      removed: 2,
      bytes: 3072 + body.length + 68,
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

test('cancellation markers are retained and bounded by an explicit quota', async () => {
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
    { directory, encryptionKey, reserveBytes: 0, allowSharedWriters: true },
    async () => body.length + 68,
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
      allowSharedWriters: true,
      encryptionKey: randomBytes(32).toString('hex'),
    });
    try {
      await wrongKey.initialize();
      await assert.rejects(wrongKey.get(object, version), /unable to authenticate data/);
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
      allowSharedWriters: true,
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
    await writeFile(corruptPath, Buffer.alloc(body.length + 68));
    await assert.rejects(storage.cancelUpload(corrupt));
    assert.deepEqual(await readFile(corruptPath), Buffer.alloc(body.length + 68));
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
    allowSharedWriters: true,
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
    assert.equal(envelope.subarray(0, 4).toString(), 'CSR1');
    assert.equal(envelope.length, body.length + 68, 'magic + version + nonce + tag + ciphertext');
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
      allowSharedWriters: true,
      encryptionKey: randomBytes(32).toString('hex'),
    });
    await stranger.initialize();
    await assert.rejects(stranger.get(object, version), /unable to authenticate data/);
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

test('a temporary stamped ahead of the process clock is still reclaimed at startup', async () => {
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

    assert.deepEqual(await storage.reclaimTemporariesAtStartup(), { removed: 1, bytes: 512 });
    assert.deepEqual(
      (await readdir(directory)).filter((name) => name.endsWith('.pending')),
      [],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a second writer on the same directory is refused and a dead writer lock is taken over', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'careerscope-lock-'));
  const encryptionKey = randomBytes(32).toString('hex');
  const first = new PrivateFileResumeStorage({ directory, encryptionKey });
  const second = new PrivateFileResumeStorage({ directory, encryptionKey });
  const third = new PrivateFileResumeStorage({ directory, encryptionKey });
  const lock = join(directory, '.writer.lock');
  try {
    await assert.rejects(first.reclaimTemporariesAtStartup(), /not initialized|lock is not held/);
    await first.initialize();
    const stranded = join(directory, `${randomUUID()}.pending`);
    await writeFile(stranded, Buffer.alloc(16));

    await assert.rejects(second.initialize(), /already in use by writer process/);
    await assert.rejects(second.reclaimTemporariesAtStartup(), /not initialized|lock is not held/);
    assert.equal((await readFile(stranded)).length, 16);

    // Releasing the lock lets the next writer start, and it then reclaims the temporary.
    first.close();
    await assert.rejects(readFile(lock), { code: 'ENOENT' });
    await second.initialize();
    assert.equal((await second.reclaimTemporariesAtStartup()).removed, 1);
    second.close();

    // A lock left by a process that no longer exists is replaced.
    await writeFile(
      lock,
      JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: new Date(0).toISOString(), directory }),
    );
    await third.initialize();
    assert.equal(JSON.parse(await readFile(lock, 'utf8')).pid, process.pid);
  } finally {
    first.close();
    second.close();
    third.close();
    await rm(directory, { recursive: true, force: true });
  }
});
