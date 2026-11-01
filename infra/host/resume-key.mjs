import { randomBytes } from 'node:crypto';
import { link, lstat, open, readFile, readdir, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const KEY_PATTERN = /^[a-f0-9]{64}\r?\n?$/;

/** Raised for an existing key file that cannot decrypt anything. The message is for the operator. */
export class ResumeKeyError extends Error {
  constructor(path, detail) {
    super(
      `Resume encryption key ${path} is ${detail}. Refusing to start and not overwriting it. ` +
        'Restore the matching key copy from wherever the owner keeps it. ' +
        'Only if no resume was ever stored may the file be deleted ' +
        'so that this step creates a new key.',
    );
    this.name = 'ResumeKeyError';
  }
}

async function readExistingKey(path) {
  const info = await lstat(path);
  if (!info.isFile()) throw new ResumeKeyError(path, 'not a regular file');
  const text = await readFile(path, 'utf8');
  if (!KEY_PATTERN.test(text)) {
    const detail =
      info.size === 0
        ? 'empty (an earlier start was interrupted while writing it)'
        : `truncated or malformed (${info.size} bytes; 64 hex characters are required)`;
    throw new ResumeKeyError(path, detail);
  }
}

async function syncDirectory(path) {
  let handle;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch {
    // Some filesystems cannot fsync a directory; the file itself was already synced.
  } finally {
    await handle?.close();
  }
}

// A crash between creating the temporary file and linking it leaves the temporary behind. Remove
// those once they are old enough that no live start can still be using them.
async function removeStaleTemporaries(path) {
  const directory = dirname(path);
  const prefix = `${basename(path)}.tmp-`;
  for (const name of await readdir(directory)) {
    if (!name.startsWith(prefix)) continue;
    const candidate = join(directory, name);
    const info = await lstat(candidate).catch(() => undefined);
    if (info && Date.now() - info.mtimeMs > 60_000) await unlink(candidate).catch(() => undefined);
  }
}

/**
 * Makes sure `path` holds a complete 64-hex-character key. A new key is written to a temporary
 * file (exclusive create, mode 0600), fsynced, then linked into place, so a crash leaves either no
 * key or a complete one, never an empty or partial file. link() fails with EEXIST instead of
 * replacing a key another process created first. An existing key is validated, never replaced.
 * Returns 'created' or 'existing'.
 */
export async function ensureResumeKey(path) {
  try {
    await readExistingKey(path);
    return 'existing';
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await removeStaleTemporaries(path);
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  const key = randomBytes(32);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(key.toString('hex'));
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, path);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await readExistingKey(path);
      return 'existing';
    }
    await syncDirectory(dirname(path));
    return 'created';
  } finally {
    key.fill(0);
    await handle?.close();
    await unlink(temporary).catch(() => undefined);
  }
}
