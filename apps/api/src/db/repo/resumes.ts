/**
 * Uploaded resumes.
 *
 * The row and the file on disk are two halves of one thing, so this repo owns
 * both — a caller that deletes a row without unlinking the file leaves an
 * orphaned resume in `data/resumes/`, and one that unlinks without deleting the
 * row leaves a download link that 404s.
 *
 * `resumeSchema` deliberately has no `text` field: the extracted text is large
 * and is only needed server-side, by the matcher and the LLM rerank. It is
 * stored in the column and returned by `text()` rather than shipped to the
 * browser on every profile load.
 */

import { readFile, unlink, writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { resumeSchema, type DerivedResume, type Resume } from '@job-radar/shared';
import { fromJson, toNumberOrNull, toText, type Db, type Row } from '../index.js';
import { LOCAL_USER_ID, newId, safeFilename } from '../../util/ids.js';

function rowToResume(row: Row): Resume {
  return resumeSchema.parse({
    id: toText(row['id']),
    filename: toText(row['filename']),
    mimeType: toText(row['mime_type']),
    sizeBytes: toNumberOrNull(row['size_bytes']) ?? 0,
    textLength: toNumberOrNull(row['text_length']) ?? 0,
    derived: fromJson<DerivedResume>(row['derived'], 'resumes.derived'),
    createdAt: toText(row['created_at']),
  });
}

export interface StoreResumeInput {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  text: string;
  derived: DerivedResume;
}

export class ResumeRepo {
  /** `<dataDir>/resumes`, created on construction so the first upload cannot fail on it. */
  readonly dir: string;

  constructor(
    private readonly db: Db,
    dataDir: string,
  ) {
    this.dir = join(dataDir, 'resumes');
    mkdirSync(this.dir, { recursive: true });
  }

  get(id: string): Resume | null {
    const row = this.db.get('SELECT * FROM resumes WHERE id = :id', { id });
    return row ? rowToResume(row) : null;
  }

  list(limit = 20): Resume[] {
    return this.db
      .all('SELECT * FROM resumes ORDER BY created_at DESC LIMIT :limit', { limit })
      .map(rowToResume);
  }

  /** The extracted text, for the matcher and the rerank. Never sent to the browser. */
  text(id: string): string | null {
    const row = this.db.get('SELECT text FROM resumes WHERE id = :id', { id });
    return row ? toText(row['text']) : null;
  }

  /** The original bytes, for the "download my resume" link. */
  async file(id: string): Promise<Uint8Array | null> {
    const row = this.db.get('SELECT storage_path FROM resumes WHERE id = :id', { id });
    if (!row) return null;
    try {
      return await readFile(toText(row['storage_path']));
    } catch {
      // The row outlived the file — a restored database against an empty volume,
      // most likely. The metadata is still useful, so this is null, not a throw.
      return null;
    }
  }

  /**
   * Writes the file and the row.
   *
   * The stored filename is a fresh UUID, never the uploaded one: the browser
   * controls that string and `../../.ssh/authorized_keys` is a legal value for
   * it. The original is kept only as a display label, itself sanitised.
   */
  async store(input: StoreResumeInput, at: string): Promise<Resume> {
    const id = newId();
    const storagePath = join(this.dir, id);
    await writeFile(storagePath, input.bytes);

    try {
      this.db.run(
        `INSERT INTO resumes (id, user_id, filename, mime_type, size_bytes, storage_path,
                              text, text_length, derived, created_at)
         VALUES (:id, :userId, :filename, :mimeType, :sizeBytes, :storagePath,
                 :text, :textLength, :derived, :at)`,
        {
          id,
          userId: LOCAL_USER_ID,
          filename: safeFilename(input.filename),
          mimeType: input.mimeType,
          sizeBytes: input.bytes.byteLength,
          storagePath,
          text: input.text,
          textLength: input.text.length,
          derived: input.derived,
          at,
        },
      );
    } catch (error) {
      // Do not leave the file behind if the row failed; an orphan on disk is
      // invisible and never gets cleaned up.
      await unlink(storagePath).catch(() => {});
      throw error;
    }

    return this.get(id)!;
  }

  /** Deletes the row and the file. Missing file is fine — the row is what matters. */
  async delete(id: string): Promise<boolean> {
    const row = this.db.get('SELECT storage_path FROM resumes WHERE id = :id', { id });
    if (!row) return false;
    this.db.run('DELETE FROM resumes WHERE id = :id', { id });
    await unlink(toText(row['storage_path'])).catch(() => {});
    return true;
  }

  /**
   * Removes every resume except the newest `keep`.
   *
   * Uploading a corrected resume is common and each one is a few hundred KB, so
   * without this the directory grows without bound on a box whose disk is the
   * thing most likely to fill.
   */
  async prune(keep = 5): Promise<number> {
    const stale = this.db.all(
      `SELECT id FROM resumes WHERE id NOT IN (
         SELECT id FROM resumes ORDER BY created_at DESC LIMIT :keep
       ) AND id NOT IN (SELECT resume_id FROM profiles WHERE resume_id IS NOT NULL)`,
      { keep },
    );
    let removed = 0;
    for (const row of stale) {
      if (await this.delete(toText(row['id']))) removed += 1;
    }
    return removed;
  }
}
