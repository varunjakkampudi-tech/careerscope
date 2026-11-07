import sharp from 'sharp';

export const maximumProfilePhotoUploadBytes = 5 * 1024 * 1024;
export const maximumProfilePhotoStorageBytes = 512 * 1024;
export const profilePhotoContentTypes = ['image/jpeg', 'image/png', 'image/webp'] as const;

const formats = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;

/** Safe rejection with no decoder details or untrusted input included in the message. */
export class InvalidProfilePhoto extends Error {
  constructor() {
    super('Choose a valid JPEG, PNG, or WebP image.');
  }
}

/** Decode and normalize an uploaded image to metadata-free WebP before it is stored. */
export async function normalizeProfilePhoto(
  input: Buffer,
  declaredContentType: string | undefined,
): Promise<Buffer> {
  const contentType = declaredContentType?.split(';', 1)[0]?.trim().toLowerCase();
  if (
    !Buffer.isBuffer(input) ||
    input.length === 0 ||
    input.length > maximumProfilePhotoUploadBytes ||
    !contentType ||
    !Object.hasOwn(formats, contentType)
  )
    throw new InvalidProfilePhoto();

  try {
    const pipeline = sharp(input, {
      failOn: 'error',
      limitInputPixels: 16_000_000,
      animated: false,
      pages: 1,
    });
    const metadata = await pipeline.metadata();
    if (
      metadata.format !== formats[contentType as keyof typeof formats] ||
      !metadata.width ||
      !metadata.height ||
      (metadata.pages ?? 1) !== 1
    )
      throw new InvalidProfilePhoto();

    const { data } = await pipeline
      .rotate()
      .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82, effort: 4 })
      .toBuffer({ resolveWithObject: true });
    if (data.length > maximumProfilePhotoStorageBytes) throw new InvalidProfilePhoto();
    return data;
  } catch (error) {
    if (error instanceof InvalidProfilePhoto) throw error;
    throw new InvalidProfilePhoto();
  }
}
