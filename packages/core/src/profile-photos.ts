import { z } from 'zod';
import type { Database } from './database.js';

const ownerIdSchema = z.string().uuid();

export type ProfilePhoto = { image: Buffer; updatedAt: Date };

/** One private, normalized photo per owner. No public URL or cross-owner lookup is exposed. */
export class ProfilePhotoRepository {
  constructor(private readonly database: Database) {}

  async get(ownerId: string): Promise<ProfilePhoto | null> {
    const owner = ownerIdSchema.parse(ownerId);
    const result = await this.database.pool.query<ProfilePhoto>(
      'SELECT image, updated_at AS "updatedAt" FROM profile_photos WHERE owner_id = $1',
      [owner],
    );
    return result.rows[0] ?? null;
  }

  async save(ownerId: string, image: Buffer): Promise<void> {
    const owner = ownerIdSchema.parse(ownerId);
    if (!Buffer.isBuffer(image) || image.byteLength < 12 || image.byteLength > 512 * 1024)
      throw new Error('Normalized profile photo is outside its storage limit');
    await this.database.pool.query(
      `INSERT INTO profile_photos (owner_id, image)
       VALUES ($1, $2)
       ON CONFLICT (owner_id) DO UPDATE SET image = EXCLUDED.image, updated_at = now()`,
      [owner, image],
    );
  }

  async delete(ownerId: string): Promise<boolean> {
    const owner = ownerIdSchema.parse(ownerId);
    const result = await this.database.pool.query(
      'DELETE FROM profile_photos WHERE owner_id = $1',
      [owner],
    );
    return result.rowCount === 1;
  }
}
