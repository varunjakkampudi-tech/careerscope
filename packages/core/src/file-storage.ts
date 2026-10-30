/**
 * Encrypted, private-directory resume storage implementing `ResumeObjectStore` (see `storage.ts`).
 * Objects are AES-256-GCM files bound to their owner, resume and digest; the API and the file worker
 * use it through `resumes.ts`. Capacity limits come from `ResumeStorageLimit`.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { constants } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  statfs,
  unlink,
} from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { resumeUploadMetadataSchema, type ResumeObject } from './storage.js';
import { Conflict } from './errors.js';
import { ResumeStorageLimit } from './resumes.js';

/** Storage-side view of an object: the upload metadata plus owner and resume ids, with unknown keys rejected. */
const objectSchema = resumeUploadMetadataSchema
  .extend({
    ownerId: z.string().uuid(),
    resumeId: z.string().uuid(),
  })
  .strict();
const versionSchema = z.string().uuid();
/** Envelope header size in bytes: "CSR1" magic (4), version UUID (36), GCM nonce (12) and auth tag (16). */
const overhead = 68;
/** Name pattern of in-progress writes; only these files are ever candidates for cleanup. */
const temporaryName = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pending$/;
/** Free space that must remain on the volume after a write is admitted (256 MiB). */
const defaultReserveBytes = 256 * 1024 * 1024;
/**
 * Cancellation markers fence late publication permanently, so they are never
 * deleted automatically. This bounds how many may accumulate before operators
 * are warned and new cancellations are refused.
 */
const defaultMarkerLimit = 10_000;

/** Raised when an upload was cancelled before it was published; the cancellation marker blocks a late publish. */
export class ResumeUploadCancelled extends Conflict {
  constructor(message: string) {
    super(message, 'UPLOAD_CANCELLED');
  }
}

/** A concurrent writer replaced the object between inspection and reading. */
class ResumeObjectChanged extends Error {}

function missing(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** Transient contention only. Permission failures must surface immediately. */
function contended(error: unknown) {
  return (
    error instanceof ResumeObjectChanged ||
    (error instanceof Error &&
      'code' in error &&
      typeof error.code === 'string' &&
      ['EPERM', 'EBUSY'].includes(error.code))
  );
}

/** The volume or quota is genuinely full, regardless of earlier admission checks. */
function exhausted(error: unknown) {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    ['ENOSPC', 'EDQUOT', 'EFBIG'].includes(error.code)
  );
}

/**
 * Filesystem store for encrypted resumes. The directory must be absolute, private and free of
 * symbolic links. Each object is one file named by owner, resume and digest, written to a temporary
 * file and published with an exclusive hard link, so a published object is never partially written or overwritten.
 */
export class PrivateFileResumeStorage {
  readonly bucket = 'local-private-resumes';
  private readonly root: string;
  private readonly key: Buffer;
  private readonly reserveBytes: number;
  private readonly markerLimit: number;
  private reserved = 0;
  private capacityRefusals = 0;
  private markers = 0;
  private reclaimedTemporaries = 0;
  private ready = false;

  constructor(
    config: {
      directory: string;
      encryptionKey: string;
      reserveBytes?: number;
      markerLimit?: number;
    },
    private readonly availableBytes: (directory: string) => Promise<number> = async (directory) => {
      const volume = await statfs(directory);
      return Number(volume.bavail) * Number(volume.bsize);
    },
  ) {
    if (!isAbsolute(config.directory)) throw new Error('Resume directory must be absolute');
    this.root = resolve(config.directory);
    this.reserveBytes = z
      .number()
      .int()
      .min(0)
      .default(defaultReserveBytes)
      .parse(config.reserveBytes);
    this.markerLimit = z
      .number()
      .int()
      .min(1)
      .default(defaultMarkerLimit)
      .parse(config.markerLimit);
    this.key = Buffer.from(
      z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(config.encryptionKey),
      'hex',
    );
  }

  /** Creates the directory (mode 0700), validates it, and counts existing cancellation markers. Must run before any other call. */
  async initialize(signal?: AbortSignal) {
    signal?.throwIfAborted();
    this.ready = false;
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.checkDirectory();
    this.ready = true;
    try {
      this.markers = (await this.inventory(signal)).markers;
    } catch (error) {
      this.ready = false;
      throw error;
    }
  }

  // Checked on every operation, not only at startup, so replacing the directory with a symlink later is detected.
  private async checkDirectory() {
    const stat = await lstat(this.root);
    const canonical = await realpath(this.root);
    const expected = process.platform === 'win32' ? this.root.toLowerCase() : this.root;
    const actual = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
    if (!stat.isDirectory() || stat.isSymbolicLink() || actual !== expected) {
      throw new Error('Resume directory must not use symbolic links');
    }
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw new Error('Resume directory must be private');
    }
  }

  /** Validates the object and resolves its file path. Re-checks the directory every time. */
  private async path(input: ResumeObject, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const object = objectSchema.parse(input);
    if (!this.ready) throw new Error('Resume storage is not initialized');
    await this.checkDirectory();
    return {
      object,
      filename: join(this.root, `${object.ownerId}_${object.resumeId}_${object.sha256}.bin`),
    };
  }

  /** Confirms size and SHA-256 match the declared metadata before writing and after decrypting. */
  private validateBody(object: ResumeObject, body: Uint8Array) {
    if (
      body.byteLength !== object.bytes ||
      createHash('sha256').update(body).digest('hex') !== object.sha256
    ) {
      throw new Error('Resume object integrity check failed');
    }
  }

  /** Authenticated data for GCM: binds ciphertext to the object identity and version, so a file moved to another path fails decryption. */
  private aad(object: ResumeObject, version: string) {
    return Buffer.from(JSON.stringify({ object: objectSchema.parse(object), version }));
  }

  /** 36-byte marker: "CSC1" plus an HMAC of the object identity. Placed at the object path so a later publish of that object fails. */
  private cancellationMarker(object: ResumeObject) {
    return Buffer.concat([
      Buffer.from('CSC1'),
      createHmac('sha256', this.key).update(this.aad(object, 'cancelled')).digest(),
    ]);
  }

  /** Flushes directory entries after link, rename or unlink so the change survives a crash. Not available on Windows. */
  private async syncDirectory() {
    if (process.platform === 'win32') return;
    const directory = await open(this.root, constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  /**
   * Physical storage state. The database reservation budget cannot see
   * encryption overhead, abandoned temporary files or unrelated volume usage.
   */
  async inventory(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!this.ready) throw new Error('Resume storage is not initialized');
    await this.checkDirectory();
    const entries = await readdir(this.root, { withFileTypes: true });
    let objects = 0;
    let objectBytes = 0;
    let temporaries = 0;
    let temporaryBytes = 0;
    let oldestTemporaryMs: number | null = null;
    let markers = 0;
    let markerBytes = 0;
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (!entry.isFile()) continue;
      const stat = await lstat(join(this.root, entry.name)).catch((error: unknown) => {
        if (missing(error)) return null;
        throw error;
      });
      if (!stat) continue;
      if (entry.name.endsWith('.bin')) {
        objects += 1;
        objectBytes += stat.size;
        // Cancellation markers are retained forever, so their growth needs a signal.
        if (stat.size === 36) {
          markers += 1;
          markerBytes += stat.size;
        }
      } else if (temporaryName.test(entry.name)) {
        temporaries += 1;
        temporaryBytes += stat.size;
        oldestTemporaryMs =
          oldestTemporaryMs === null ? stat.mtimeMs : Math.min(oldestTemporaryMs, stat.mtimeMs);
      }
    }
    const volume = await statfs(this.root);
    const freeBytes = Number(volume.bavail) * Number(volume.bsize);
    return {
      objects,
      objectBytes,
      markers,
      markerBytes,
      temporaries,
      temporaryBytes,
      oldestTemporaryMs,
      freeBytes,
      totalBytes: Number(volume.blocks) * Number(volume.bsize),
      reserveBytes: this.reserveBytes,
      markerLimit: this.markerLimit,
      markersExceeded: markers >= this.markerLimit,
      // Non-zero while no upload is in flight indicates a leaked reservation.
      reservedBytes: this.reserved,
      capacityRefusals: this.capacityRefusals,
      reclaimedTemporaries: this.reclaimedTemporaries,
      belowReserve: freeBytes < this.reserveBytes,
    };
  }

  /**
   * Reclaims temporaries stranded by a crashed writer. Only temporaries at least
   * 10 minutes old are removed: a live writer's temporaries are normally younger,
   * and a writer stalled past the bound retries once (see put and cancelUpload),
   * so several writers may safely share one directory. A future-stamped
   * temporary has age 0 and is kept until it ages.
   *
   * An old temporary already linked into its published object is also reclaimed
   * here: removing that extra name leaves the published object itself intact.
   */
  async reclaimTemporariesAtStartup(signal?: AbortSignal) {
    const result = await this.removeTemporaries(
      { olderThanMs: 600000, limit: 1000, now: Date.now(), linked: true },
      signal,
    );
    this.reclaimedTemporaries += result.removed;
    return result;
  }

  /**
   * Removes abandoned temporary files left by an interrupted write or
   * cancellation. Published objects and cancellation markers are never
   * candidates: they are only ever created by link or rename onto a `.bin` path.
   *
   * Maintenance only: all writers must be stopped before calling this method.
   * Age does not prove abandonment; a suspended process may still own the file.
   * A temporary already linked into a published object is preserved.
   */
  async sweepAbandonedTemporaries(
    options?: { olderThanMs?: number; limit?: number; now?: number },
    signal?: AbortSignal,
  ) {
    return this.removeTemporaries(
      {
        olderThanMs: Math.max(options?.olderThanMs ?? 3600000, 600000),
        limit: options?.limit ?? 100,
        now: options?.now ?? Date.now(),
      },
      signal,
    );
  }

  private async removeTemporaries(
    options: { olderThanMs: number; limit: number; now: number; linked?: boolean },
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    if (!this.ready) throw new Error('Resume storage is not initialized');
    await this.checkDirectory();
    const { olderThanMs, now } = options;
    const limit = Math.min(Math.max(options.limit, 1), 1000);
    const entries = await readdir(this.root, { withFileTypes: true });
    let removed = 0;
    let bytes = 0;
    for (const entry of entries) {
      if (removed >= limit) break;
      signal?.throwIfAborted();
      if (!entry.isFile() || !temporaryName.test(entry.name)) continue;
      const filename = join(this.root, entry.name);
      const stat = await lstat(filename).catch((error: unknown) => {
        if (missing(error)) return null;
        throw error;
      });
      if (
        !stat ||
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        (stat.nlink !== 1 && !options.linked) ||
        // A temporary timestamped slightly ahead of this process clock has zero age, not negative age.
        Math.max(0, now - stat.mtimeMs) < olderThanMs
      )
        continue;
      try {
        await unlink(filename);
      } catch (error) {
        if (missing(error)) continue;
        if (!contended(error)) throw error;
        continue;
      }
      removed += 1;
      bytes += stat.size;
    }
    if (removed) await this.syncDirectory();
    return { removed, bytes };
  }

  /** Reserves `bytes` against free space minus the reserve, or throws `ResumeStorageLimit`. Returns a one-shot release function. */
  private async ensureCapacity(bytes: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const free = await this.availableBytes(this.root);
    signal?.throwIfAborted();
    if (free - this.reserved - bytes < this.reserveBytes) {
      this.capacityRefusals += 1;
      throw new ResumeStorageLimit('Resume storage volume capacity reached');
    }
    this.reserved += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.reserved -= bytes;
    };
  }

  /** Seam for out-of-space regressions: the durable write of a published object. */
  protected async writeTemporary(temporary: string, envelope: Buffer, signal?: AbortSignal) {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(envelope, { signal });
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /** Seam for out-of-space regressions: exclusive publication of the object. */
  protected async publishObject(temporary: string, filename: string) {
    await link(temporary, filename);
  }

  /**
   * Encrypts and stores an object, returning its version id. The body must match the declared size
   * and digest. Writes a temporary file, syncs it, then publishes with `link` so an existing object or
   * cancellation marker makes the call fail instead of being overwritten.
   */
  async put(input: ResumeObject, body: Uint8Array, signal?: AbortSignal): Promise<string> {
    const { object, filename } = await this.path(input, signal);
    const data = Buffer.from(body);
    this.validateBody(object, data);
    const version = randomUUID();
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(this.aad(object, version));
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    const envelope = Buffer.concat([
      Buffer.from('CSR1'),
      Buffer.from(version),
      nonce,
      cipher.getAuthTag(),
      encrypted,
    ]);
    const release = await this.ensureCapacity(envelope.length, signal);
    try {
      // A temporary stalled past the reclaim bound can be removed before it is linked.
      // That surfaces as ENOENT from the publish, so the whole write is retried once.
      for (let attempt = 0; ; attempt++) {
        const temporary = join(this.root, `${randomUUID()}.pending`);
        try {
          await this.writeTemporary(temporary, envelope, signal);
          signal?.throwIfAborted();
          await this.publishObject(temporary, filename);
          await this.syncDirectory();
          return version;
        } catch (error) {
          if (attempt === 0 && missing(error)) continue;
          throw error;
        } finally {
          await unlink(temporary).catch((error: unknown) => {
            if (!missing(error)) throw error;
          });
        }
      }
    } catch (error) {
      // Admission control is a guard, not a guarantee: another writer can consume
      // the volume first, so a real out-of-space failure keeps the same contract.
      if (exhausted(error)) throw new ResumeStorageLimit('Resume storage volume capacity reached');
      throw error;
    } finally {
      release();
    }
  }

  /**
   * Reads and decrypts an object. A 36-byte file is a cancellation marker (`ResumeUploadCancelled` if
   * it is ours). The opened file's inode and size are compared with the earlier `lstat` to detect a
   * concurrent replacement, and the file is opened with O_NOFOLLOW.
   */
  private async read(input: ResumeObject, expectedVersion?: string, signal?: AbortSignal) {
    const { object, filename } = await this.path(input, signal);
    if (expectedVersion !== undefined) versionSchema.parse(expectedVersion);
    const stat = await lstat(filename);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.size === 36) {
      const markerHandle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const marker = Buffer.alloc(36);
        const result = await markerHandle.read(marker, 0, marker.length, 0);
        if (
          result.bytesRead === marker.length &&
          timingSafeEqual(marker, this.cancellationMarker(object))
        )
          throw new ResumeUploadCancelled('Resume upload cancelled');
      } finally {
        await markerHandle.close();
      }
      throw new Error('Resume object metadata mismatch');
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== object.bytes + overhead) {
      throw new Error('Resume object metadata mismatch');
    }
    const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.ino !== stat.ino ||
        opened.dev !== stat.dev ||
        opened.size !== stat.size
      ) {
        throw new ResumeObjectChanged('Resume object changed during read');
      }
      const envelope = Buffer.alloc(object.bytes + overhead);
      let offset = 0;
      while (offset < envelope.length) {
        signal?.throwIfAborted();
        const read = await handle.read(envelope, offset, envelope.length - offset, offset);
        if (!read.bytesRead) throw new Error('Resume object truncated');
        offset += read.bytesRead;
      }
      if (
        (await handle.stat()).size !== envelope.length ||
        envelope.subarray(0, 4).toString() !== 'CSR1'
      ) {
        throw new Error('Resume object metadata mismatch');
      }
      const version = versionSchema.parse(envelope.subarray(4, 40).toString());
      if (expectedVersion !== undefined && expectedVersion !== version)
        throw new Error('Resume object version mismatch');
      const decipher = createDecipheriv('aes-256-gcm', this.key, envelope.subarray(40, 52));
      decipher.setAAD(this.aad(object, version));
      decipher.setAuthTag(envelope.subarray(52, 68));
      const data = Buffer.concat([decipher.update(envelope.subarray(overhead)), decipher.final()]);
      this.validateBody(object, data);
      signal?.throwIfAborted();
      return { version, data };
    } finally {
      await handle.close();
    }
  }

  /** Decrypted bytes for the given version; throws if the stored version differs. */
  async get(object: ResumeObject, version: string, signal?: AbortSignal) {
    return (await this.read(object, version, signal)).data;
  }

  /** The stored version id, or null if no object exists. Lets a retried upload reuse an object that was already stored. */
  async recoverVersion(object: ResumeObject, signal?: AbortSignal): Promise<string | null> {
    try {
      return (await this.read(object, undefined, signal)).version;
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  /** Removes an object after verifying it is readable at that version. Missing objects are not an error. */
  async delete(object: ResumeObject, version: string, signal?: AbortSignal) {
    try {
      await this.read(object, version, signal);
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
    const { filename } = await this.path(object, signal);
    try {
      await unlink(filename);
    } catch (error) {
      if (!missing(error)) throw error;
    }
    await this.syncDirectory();
  }

  /** Writes a cancellation marker at the object path so a late `put` for it cannot publish. Refused once the marker quota is reached. */
  async cancelUpload(object: ResumeObject, signal?: AbortSignal) {
    // Markers are never deleted automatically, so accumulation is bounded here
    // instead of being reclaimed later.
    if (this.markers >= this.markerLimit) {
      throw new ResumeStorageLimit('Resume cancellation marker quota reached');
    }
    const { filename } = await this.path(object, signal);
    try {
      // A temporary reclaimed while this writer stalled makes the publish fail with
      // ENOENT, so the whole write is retried once with a fresh temporary.
      for (let attempt = 0; ; attempt++) {
        const temporary = join(this.root, `${randomUUID()}.pending`);
        let handle;
        try {
          handle = await open(temporary, 'wx', 0o600);
          await handle.writeFile(this.cancellationMarker(object), { signal });
          await handle.sync();
          await handle.close();
          signal?.throwIfAborted();
          if (await this.publishCancellation(object, temporary, filename, signal))
            this.markers += 1;
          await this.syncDirectory();
          return;
        } catch (error) {
          if (attempt === 0 && missing(error)) continue;
          throw error;
        } finally {
          await handle?.close();
          await unlink(temporary).catch((error: unknown) => {
            if (!missing(error)) throw error;
          });
        }
      }
    } catch (error) {
      // Cancellation is authoritative only once its marker is durable, so an
      // exhausted volume must fail with the same typed limit as a write.
      if (exhausted(error)) throw new ResumeStorageLimit('Resume storage volume capacity reached');
      throw error;
    }
  }

  /**
   * Publishes the cancellation marker at the object's own path. Concurrent
   * cancellations of the same upload converge instead of surfacing platform
   * contention: a marker already in place means cancellation succeeded.
   * Returns whether this call installed a new marker.
   */
  private async publishCancellation(
    object: ResumeObject,
    temporary: string,
    filename: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    let contention: unknown;
    for (let attempt = 0; attempt < 10; attempt++) {
      signal?.throwIfAborted();
      try {
        await link(temporary, filename);
        return true;
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
        contention = error;
      }
      try {
        const version = await this.recoverVersion(object, signal);
        if (version) {
          await this.get(object, version, signal);
          signal?.throwIfAborted();
          await rename(temporary, filename);
          return true;
        }
      } catch (failure) {
        if (failure instanceof ResumeUploadCancelled) return false;
        if (!contended(failure)) throw failure;
        contention = failure;
      }
      await delay(5 * (attempt + 1), undefined, { signal });
    }
    throw new Error('Resume object changed during cancellation', { cause: contention });
  }

  /** Marks the store unusable and zeroes the in-memory key. */
  close() {
    this.ready = false;
    this.key.fill(0);
  }
}

/**
 * Builds storage from `RESUME_STORAGE_DIRECTORY` and `RESUME_STORAGE_KEY_FILE`, or returns undefined
 * if neither is set. The key file must be a private regular file (not a symlink) holding a 64-character hex key.
 */
export async function configuredFileResumeStorage(source: NodeJS.ProcessEnv = process.env) {
  const directory = source.RESUME_STORAGE_DIRECTORY;
  const keyFile = source.RESUME_STORAGE_KEY_FILE;
  if (directory === undefined && keyFile === undefined) return undefined;
  if (!directory || !keyFile || !isAbsolute(directory) || !isAbsolute(keyFile)) {
    throw new Error('Resume storage requires absolute directory and private key file paths');
  }
  const stat = await lstat(keyFile);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 64 ||
    stat.size > 65 ||
    (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
  ) {
    throw new Error('Resume storage key file must be private');
  }
  const handle = await open(keyFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size)
      throw new Error('Resume storage key changed');
    const key = Buffer.alloc(stat.size);
    try {
      const result = await handle.read(key, 0, key.length, 0);
      if (result.bytesRead !== key.length) throw new Error('Resume storage key truncated');
      const storage = new PrivateFileResumeStorage({
        directory,
        encryptionKey: key.toString().trim(),
        ...(source.RESUME_STORAGE_RESERVE_BYTES === undefined
          ? {}
          : {
              reserveBytes: z.coerce
                .number()
                .int()
                .min(0)
                .parse(source.RESUME_STORAGE_RESERVE_BYTES),
            }),
      });
      try {
        await storage.initialize();
        return storage;
      } catch (error) {
        storage.close();
        throw error;
      }
    } finally {
      key.fill(0);
    }
  } finally {
    await handle.close();
  }
}
