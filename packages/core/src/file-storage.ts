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
  hkdfSync,
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
/**
 * Envelope layouts (all fields fixed width, ciphertext length equals plaintext length):
 * - "CSR1" (legacy, read only): magic (4) | version UUID (36) | GCM nonce (12) | auth tag (16) | ciphertext.
 *   Encrypted directly with the raw storage key. Header 68 bytes.
 * - "CSR2" (written): magic (4) | key id (4) | version UUID (36) | GCM nonce (12) | auth tag (16) | ciphertext.
 *   Encrypted with a key derived by HKDF-SHA-256 from the storage key (info `encryptionKeyInfo`), so the
 *   cipher never uses the raw master key. Header 72 bytes. The key id is a public fingerprint derived
 *   from the storage key (info `keyIdInfo`); a reader whose key has a different id fails closed.
 * The GCM AAD is identical for both: the object identity and version (see `aad`).
 *
 * Migration rule: CSR1 objects stay readable indefinitely. Nothing rewrites them automatically. A
 * re-encrypt job (NOT built here) would, for each CSR1 object, read and verify it, write a CSR2
 * object under a new version and swap it in, and only then delete the CSR1 file. Until such a job
 * has run, the raw storage key must be retained and protected exactly as before.
 */
const legacyEnvelopeMagic = 'CSR1';
const envelopeMagic = 'CSR2';
const legacyOverhead = 68;
const overhead = 72;
const encryptionKeyInfo = 'careerscope:resume-storage:aes-gcm:v1';
const keyIdInfo = 'careerscope:resume-storage:key-id:v1';
/** Name pattern of in-progress writes; only these files are ever candidates for cleanup. */
const temporaryName = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pending$/;
/** Free space that must remain on the volume after a write is admitted (256 MiB). */
const defaultReserveBytes = 256 * 1024 * 1024;
/** Bounds how many cancellation markers may exist before operators are warned and new cancellations are refused. */
const defaultMarkerLimit = 10_000;
/** Per-owner cap, so one account cannot exhaust the global marker budget and block everyone else's cancellations. */
const defaultOwnerMarkerLimit = 100;
/** Marker file names begin with the owner UUID (36 characters), see `path`. */
const ownerIdLength = 36;
/**
 * A cancellation marker only has to outlive a write that was already in flight when the upload was
 * cancelled: the API request timeout is 15 s, and a stalled writer is bounded by the 10 minute
 * temporary floor plus one retry. 24 hours is far beyond both. After that the database row is the
 * authority (a cancelled upload cannot be queued), so the marker is reclaimed.
 */
const defaultMarkerRetentionMs = 24 * 60 * 60 * 1000;
const minimumMarkerRetentionMs = 60 * 60 * 1000;
/** Temporaries younger than this are never reclaimed, so a live writer is not disturbed. */
const temporaryFloorMs = 10 * 60 * 1000;
const defaultSweepIntervalMs = 5 * 60 * 1000;
const minimumSweepIntervalMs = 60 * 1000;
/** Legacy markers were an HMAC under the raw storage key; current markers use a key derived for that purpose only. */
const legacyMarkerMagic = 'CSC1';
const markerMagic = 'CSC2';
const markerSize = 36;
const markerKeyInfo = 'careerscope/resume-storage/cancellation-marker/v1';

/** Raised when an upload was cancelled before it was published; the cancellation marker blocks a late publish. */
export class ResumeUploadCancelled extends Conflict {
  constructor(message: string) {
    super(message, 'UPLOAD_CANCELLED');
  }
}

/** A concurrent writer replaced the object between inspection and reading. */
class ResumeObjectChanged extends Error {}

/** Adds one marker to the owner named by the first 36 characters of a marker file name. */
function countOwner(counts: Map<string, number>, name: string) {
  const owner = name.slice(0, ownerIdLength).toLowerCase();
  counts.set(owner, (counts.get(owner) ?? 0) + 1);
}

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
  /**
   * Master key. New objects ("CSR2") are encrypted with `encryptionKey` derived from it; the raw
   * key is used directly only to decrypt legacy "CSR1" objects and for legacy "CSC1" markers.
   * See the envelope comment above for the migration rule.
   */
  private readonly key: Buffer;
  /** HKDF-derived AES-256-GCM key for "CSR2" envelopes. */
  private readonly encryptionKey: Buffer;
  /** 4-byte fingerprint of the storage key carried in "CSR2" envelopes. */
  private readonly keyId: Buffer;
  /** HKDF-derived key used only for cancellation markers, so the marker HMAC and the cipher never share key material. */
  private readonly markerKey: Buffer;
  private readonly reserveBytes: number;
  private readonly markerLimit: number;
  private readonly ownerMarkerLimit: number;
  private readonly markerRetentionMs: number;
  private reserved = 0;
  private capacityRefusals = 0;
  private markers = 0;
  /** Marker counts by lower-case owner id, rebuilt from disk by `inventory` and `reclaimExpiredMarkers`. */
  private ownerMarkers = new Map<string, number>();
  private reclaimedTemporaries = 0;
  private ready = false;
  /** The in-flight `initialize`, shared by concurrent callers. Cleared when it settles. */
  private initializing: Promise<void> | undefined;

  constructor(
    config: {
      directory: string;
      encryptionKey: string;
      reserveBytes?: number;
      markerLimit?: number;
      ownerMarkerLimit?: number;
      markerRetentionMs?: number;
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
    this.ownerMarkerLimit = z
      .number()
      .int()
      .min(1)
      .default(defaultOwnerMarkerLimit)
      .parse(config.ownerMarkerLimit);
    this.key = Buffer.from(
      z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(config.encryptionKey),
      'hex',
    );
    this.markerRetentionMs = z
      .number()
      .int()
      .min(minimumMarkerRetentionMs)
      .default(defaultMarkerRetentionMs)
      .parse(config.markerRetentionMs);
    this.markerKey = Buffer.from(hkdfSync('sha256', this.key, Buffer.alloc(0), markerKeyInfo, 32));
    this.encryptionKey = Buffer.from(
      hkdfSync('sha256', this.key, Buffer.alloc(0), encryptionKeyInfo, 32),
    );
    this.keyId = Buffer.from(hkdfSync('sha256', this.key, Buffer.alloc(0), keyIdInfo, 4));
  }

  /**
   * Creates the directory (mode 0700), validates it, and counts existing cancellation markers. Must
   * run before any other call. Idempotent: a call made while another is running awaits that one
   * (and shares its signal), and a call on an initialised store re-validates and recounts without
   * ever clearing `ready`, so a concurrent sweep or request never sees an uninitialised store.
   */
  initialize(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.initializing) return this.initializing;
    const run = this.runInitialize(signal).finally(() => {
      if (this.initializing === run) this.initializing = undefined;
    });
    this.initializing = run;
    return run;
  }

  private async runInitialize(signal?: AbortSignal) {
    const wasReady = this.ready;
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.checkDirectory();
    this.ready = true;
    try {
      this.markers = (await this.inventory(signal)).markers;
    } catch (error) {
      this.ready = wasReady;
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

  /**
   * 36-byte marker: magic plus an HMAC of the object identity. Placed at the object path so a later
   * publish of that object fails. New markers ("CSC2") are keyed with the HKDF-derived marker key;
   * legacy markers ("CSC1") used the raw storage key and are still accepted when read.
   */
  private cancellationMarker(object: ResumeObject, legacy = false) {
    return Buffer.concat([
      Buffer.from(legacy ? legacyMarkerMagic : markerMagic),
      createHmac('sha256', legacy ? this.key : this.markerKey)
        .update(this.aad(object, 'cancelled'))
        .digest(),
    ]);
  }

  private isOwnMarker(object: ResumeObject, candidate: Buffer) {
    // Evaluate both so timing does not reveal which generation matched.
    const current = timingSafeEqual(candidate, this.cancellationMarker(object));
    const legacy = timingSafeEqual(candidate, this.cancellationMarker(object, true));
    return current || legacy;
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
    const ownerCounts = new Map<string, number>();
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
        // Markers are reclaimed only after the retention window, so their growth needs a signal.
        // Only a file with a marker magic counts; any other 36-byte file is not a marker.
        if (
          stat.size === markerSize &&
          stat.isFile() &&
          (await this.hasMarkerMagic(join(this.root, entry.name)))
        ) {
          markers += 1;
          markerBytes += stat.size;
          countOwner(ownerCounts, entry.name);
        }
      } else if (temporaryName.test(entry.name)) {
        temporaries += 1;
        temporaryBytes += stat.size;
        oldestTemporaryMs =
          oldestTemporaryMs === null ? stat.mtimeMs : Math.min(oldestTemporaryMs, stat.mtimeMs);
      }
    }
    this.ownerMarkers = ownerCounts;
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
   * Reclaims temporaries stranded by a failed or crashed write. Safe to call while writers are live,
   * in this or another process, because the invariant is age based: only `.pending` temporaries at
   * least 10 minutes old are removed, and a live write has a far younger temporary. If a writer
   * stalls past that bound and its temporary is removed, its publish fails with ENOENT and `put` /
   * `cancelUpload` retry once with a fresh temporary; a second ENOENT is surfaced. A future-stamped
   * temporary has age 0 and is kept until it ages.
   *
   * An old temporary already linked into its published object is also reclaimed here: removing that
   * extra name leaves the published object itself intact. Published objects and cancellation markers
   * are never candidates. Despite its name this is safe to run periodically (see `startReclaimSweep`).
   */
  async reclaimTemporariesAtStartup(signal?: AbortSignal) {
    const result = await this.removeTemporaries(
      { olderThanMs: temporaryFloorMs, limit: 1000, now: Date.now(), linked: true },
      signal,
    );
    this.reclaimedTemporaries += result.removed;
    return result;
  }

  /**
   * Runs `reclaimTemporariesAtStartup` and `reclaimExpiredMarkers` every `intervalMs` (default 5
   * minutes, minimum 1 minute) until the returned function is called. The timer is unreferenced so it
   * never keeps the process alive, ticks never overlap, and a failing tick is passed to `onError`
   * without throwing, so a sweep error cannot crash the process. Call the returned stop function
   * before `close()`.
   */
  startReclaimSweep(options: {
    intervalMs?: number;
    onResult: (result: { removed: number; bytes: number; markersRemoved: number }) => void;
    onError: (error: unknown) => void;
  }): () => void {
    const intervalMs = Math.max(
      options.intervalMs ?? defaultSweepIntervalMs,
      minimumSweepIntervalMs,
    );
    const controller = new AbortController();
    let running = false;
    const tick = async () => {
      try {
        // Not yet initialised (or closed): nothing to sweep, and not worth a log line.
        if (!this.ready) return;
        const temporaries = await this.reclaimTemporariesAtStartup(controller.signal);
        const markersRemoved = await this.reclaimExpiredMarkers(controller.signal);
        options.onResult({ ...temporaries, markersRemoved });
      } catch (error) {
        if (controller.signal.aborted) return;
        try {
          options.onError(error);
        } catch {
          // A failing reporter must not crash the process.
        }
      } finally {
        running = false;
      }
    };
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      void tick();
    }, intervalMs);
    timer.unref();
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }

  /**
   * Removes cancellation markers older than the retention window (default 24 hours) and refreshes the
   * marker count used for the quota from what is actually on disk, so the quota reflects markers
   * created by other processes and drops reclaimed ones. Only 36-byte files with a marker magic are removed.
   */
  async reclaimExpiredMarkers(signal?: AbortSignal, now = Date.now()) {
    signal?.throwIfAborted();
    if (!this.ready) throw new Error('Resume storage is not initialized');
    await this.checkDirectory();
    const entries = await readdir(this.root, { withFileTypes: true });
    let removed = 0;
    let remaining = 0;
    const ownerCounts = new Map<string, number>();
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (!entry.isFile() || !entry.name.endsWith('.bin')) continue;
      const filename = join(this.root, entry.name);
      const stat = await lstat(filename).catch((error: unknown) => {
        if (missing(error)) return null;
        throw error;
      });
      if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size !== markerSize) continue;
      if (
        removed >= 1000 ||
        Math.max(0, now - stat.mtimeMs) < this.markerRetentionMs ||
        !(await this.hasMarkerMagic(filename))
      ) {
        remaining += 1;
        countOwner(ownerCounts, entry.name);
        continue;
      }
      try {
        await unlink(filename);
      } catch (error) {
        if (!missing(error)) {
          if (!contended(error)) throw error;
          remaining += 1;
          countOwner(ownerCounts, entry.name);
        }
        continue;
      }
      removed += 1;
    }
    if (removed) await this.syncDirectory();
    this.markers = remaining;
    this.ownerMarkers = ownerCounts;
    return removed;
  }

  private async hasMarkerMagic(filename: string) {
    let handle;
    try {
      handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const head = Buffer.alloc(4);
      const result = await handle.read(head, 0, 4, 0);
      const magic = head.toString();
      return result.bytesRead === 4 && (magic === markerMagic || magic === legacyMarkerMagic);
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    } finally {
      await handle?.close();
    }
  }

  /**
   * Removes abandoned temporary files left by an interrupted write or cancellation. Published objects
   * and cancellation markers are never candidates: they are only ever created by link or rename onto
   * a `.bin` path. The age is never below the 10 minute floor (see `reclaimTemporariesAtStartup`), so
   * a live writer is not disturbed. A temporary already linked into a published object is preserved.
   */
  async sweepAbandonedTemporaries(
    options?: { olderThanMs?: number; limit?: number; now?: number },
    signal?: AbortSignal,
  ) {
    return this.removeTemporaries(
      {
        olderThanMs: Math.max(options?.olderThanMs ?? 3600000, temporaryFloorMs),
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
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, nonce);
    cipher.setAAD(this.aad(object, version));
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    const envelope = Buffer.concat([
      Buffer.from(envelopeMagic),
      this.keyId,
      Buffer.from(version),
      nonce,
      cipher.getAuthTag(),
      encrypted,
    ]);
    const release = await this.ensureCapacity(envelope.length, signal);
    try {
      // A reclaim can remove this temporary only if the write stalled past the 10 minute floor.
      // The code cannot tell that apart from any other ENOENT, so it retries the whole write
      // once with a fresh temporary and surfaces a second ENOENT.
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
    if (stat.isFile() && !stat.isSymbolicLink() && stat.size === markerSize) {
      const markerHandle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const marker = Buffer.alloc(36);
        const result = await markerHandle.read(marker, 0, marker.length, 0);
        if (result.bytesRead === marker.length && this.isOwnMarker(object, marker))
          throw new ResumeUploadCancelled('Resume upload cancelled');
      } finally {
        await markerHandle.close();
      }
      throw new Error('Resume object metadata mismatch');
    }
    // The size selects the layout; the magic must then agree with it.
    const legacy = stat.size === object.bytes + legacyOverhead;
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (!legacy && stat.size !== object.bytes + overhead)
    ) {
      throw new Error('Resume object metadata mismatch');
    }
    const header = legacy ? legacyOverhead : overhead;
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
      const envelope = Buffer.alloc(object.bytes + header);
      let offset = 0;
      while (offset < envelope.length) {
        signal?.throwIfAborted();
        const read = await handle.read(envelope, offset, envelope.length - offset, offset);
        if (!read.bytesRead) throw new Error('Resume object truncated');
        offset += read.bytesRead;
      }
      if (
        (await handle.stat()).size !== envelope.length ||
        envelope.subarray(0, 4).toString() !== (legacy ? legacyEnvelopeMagic : envelopeMagic)
      ) {
        throw new Error('Resume object metadata mismatch');
      }
      // CSR1: version at 4, nonce at 40, tag at 52. CSR2 shifts each by the 4-byte key id.
      const start = legacy ? 4 : 8;
      if (!legacy && !timingSafeEqual(envelope.subarray(4, 8), this.keyId)) {
        throw new Error('Resume object key mismatch');
      }
      const version = versionSchema.parse(envelope.subarray(start, start + 36).toString());
      if (expectedVersion !== undefined && expectedVersion !== version)
        throw new Error('Resume object version mismatch');
      const decipher = createDecipheriv(
        'aes-256-gcm',
        legacy ? this.key : this.encryptionKey,
        envelope.subarray(start + 36, start + 48),
      );
      decipher.setAAD(this.aad(object, version));
      decipher.setAuthTag(envelope.subarray(start + 48, start + 64));
      const data = Buffer.concat([decipher.update(envelope.subarray(header)), decipher.final()]);
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

  /**
   * Writes a cancellation marker at the object path so a late `put` for it cannot publish. Refused
   * once the owner's marker quota is reached, or the global backstop (neither names any owner).
   */
  async cancelUpload(object: ResumeObject, signal?: AbortSignal) {
    const { object: parsed, filename } = await this.path(object, signal);
    const owner = parsed.ownerId.toLowerCase();
    // Markers are reclaimed after the retention window; between sweeps accumulation is bounded here.
    if ((this.ownerMarkers.get(owner) ?? 0) >= this.ownerMarkerLimit) {
      throw new ResumeStorageLimit('Resume cancellation marker quota reached');
    }
    if (this.markers >= this.markerLimit) {
      throw new ResumeStorageLimit('Resume cancellation marker quota reached');
    }
    try {
      // A reclaim removes this temporary only if the write stalled past the 10 minute floor. Any
      // ENOENT is retried once with a fresh temporary; a second ENOENT is surfaced.
      for (let attempt = 0; ; attempt++) {
        const temporary = join(this.root, `${randomUUID()}.pending`);
        let handle;
        try {
          handle = await open(temporary, 'wx', 0o600);
          await handle.writeFile(this.cancellationMarker(object), { signal });
          await handle.sync();
          await handle.close();
          signal?.throwIfAborted();
          if (await this.publishCancellation(object, temporary, filename, signal)) {
            this.markers += 1;
            this.ownerMarkers.set(owner, (this.ownerMarkers.get(owner) ?? 0) + 1);
          }
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

  /** Marks the store unusable and zeroes the in-memory keys. */
  close() {
    this.ready = false;
    this.key.fill(0);
    this.markerKey.fill(0);
    this.encryptionKey.fill(0);
    this.keyId.fill(0);
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
