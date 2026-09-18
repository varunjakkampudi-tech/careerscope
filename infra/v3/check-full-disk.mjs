import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readdir, rm } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';

// On the host this re-runs itself in a container whose object directory is a
// small tmpfs, so the filesystem genuinely exhausts instead of being simulated.
if (!process.env.FULL_DISK_ROOT) {
  const repository = fileURLToPath(new URL('../../', import.meta.url)).replace(/[\\/]$/, '');
  execFileSync(
    'docker',
    [
      'run',
      '--rm',
      '-v',
      `${repository}:/repo:ro`,
      '-v',
      `${repository}/v2/node_modules:/repo/v2/node_modules:ro`,
      '--tmpfs',
      '/tiny:rw,size=2m,mode=1777',
      '-w',
      '/repo',
      '-e',
      'FULL_DISK_ROOT=/tiny',
      'node:26.8.1-bookworm-slim',
      'node',
      'infra/v3/check-full-disk.mjs',
    ],
    { stdio: 'inherit' },
  );
  process.exit(0);
}

const { PrivateFileResumeStorage, ResumeUploadCancelled } =
  await import('../../v2/packages/core/dist/file-storage.js');
const { ResumeStorageLimit } = await import('../../v2/packages/core/dist/resumes.js');

const root = process.env.FULL_DISK_ROOT;
const objects = `${root}/objects`;
await mkdir(objects, { recursive: true, mode: 0o700 });

// reserveBytes 0 disables the application admission guard on purpose: this
// acceptance is about the real write failing, not about refusing early.
const storage = new PrivateFileResumeStorage({
  directory: objects,
  encryptionKey: randomBytes(32).toString('hex'),
  reserveBytes: 0,
});
await storage.initialize();

const object = (body) => ({
  ownerId: randomUUID(),
  resumeId: randomUUID(),
  sha256: createHash('sha256').update(body).digest('hex'),
  bytes: body.length,
  contentType: 'application/pdf',
});
const body = Buffer.concat([Buffer.from('%PDF-1.7 full disk fixture'), Buffer.alloc(96 * 1024, 3)]);

let accepted = 0;
let limit;
for (let attempt = 0; attempt < 400 && !limit; attempt += 1) {
  const target = object(body);
  try {
    await storage.put(target, body);
    accepted += 1;
  } catch (error) {
    limit = error;
  }
}

assert.ok(limit, 'The volume never filled; increase the fixture size or shrink the tmpfs');
assert.ok(
  limit instanceof ResumeStorageLimit,
  `Out of space surfaced as ${limit?.constructor?.name}: ${limit?.message}`,
);
assert.ok(accepted > 0, 'No object was stored before exhaustion');

const entries = await readdir(objects);
const stranded = entries.filter((entry) => entry.endsWith('.pending'));
assert.deepEqual(stranded, [], 'A temporary was stranded by the failed write');
assert.equal(entries.filter((entry) => entry.endsWith('.bin')).length, accepted);

const inventory = await storage.inventory();
assert.equal(inventory.reservedBytes, 0, 'A reservation leaked after the failed write');

// Cancellation is reported as observed, not assumed: the marker write also needs space.
const cancelled = object(body);
let cancellation = 'succeeded';
try {
  await storage.cancelUpload(cancelled);
  await assert.rejects(storage.recoverVersion(cancelled), ResumeUploadCancelled);
} catch (error) {
  cancellation = `${error?.constructor?.name}: ${error?.code ?? error?.message}`;
}

// Now exhaust the volume to the last byte so the marker itself cannot be written.
const filler = `${objects}/../filler`;
for (let chunk = 65536; chunk >= 1; chunk = Math.floor(chunk / 4)) {
  for (;;) {
    try {
      await appendFile(filler, Buffer.alloc(chunk, 1));
    } catch {
      break;
    }
  }
}
const starved = object(body);
let starvedCancellation = 'succeeded';
try {
  await storage.cancelUpload(starved);
} catch (error) {
  starvedCancellation = error?.constructor?.name ?? String(error);
}
assert.equal(
  starvedCancellation,
  'ResumeStorageLimit',
  `Cancellation on an exhausted volume must be typed, not ${starvedCancellation}`,
);
assert.deepEqual(
  (await readdir(objects)).filter((entry) => entry.endsWith('.pending')),
  [],
  'A failed cancellation stranded a temporary',
);
assert.equal((await storage.inventory()).reservedBytes, 0);
await rm(filler, { force: true });

// Freeing space must make cancellation work again without a restart.
await storage.cancelUpload(starved);
await assert.rejects(storage.recoverVersion(starved), ResumeUploadCancelled);

const after = await storage.inventory();

process.stdout.write(
  `${JSON.stringify(
    {
      storedBeforeExhaustion: accepted,
      exhaustionError: limit.constructor.name,
      strandedTemporaries: stranded.length,
      reservedBytesAfterFailure: inventory.reservedBytes,
      cancellationWithSlack: cancellation,
      cancellationOnExhaustedVolume: starvedCancellation,
      cancellationRetriedAfterRelease: 'succeeded',
      freeBytesAfterRelease: after.freeBytes,
    },
    null,
    2,
  )}\n`,
);
storage.close();
