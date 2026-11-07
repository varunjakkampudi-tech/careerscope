import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { InvalidProfilePhoto, normalizeProfilePhoto } from './profile-photo.js';

const transparentPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==',
  'base64',
);

test('profile photos are decoded and normalized to metadata-free WebP', async () => {
  const normalized = await normalizeProfilePhoto(transparentPng, 'image/png');
  const metadata = await sharp(normalized).metadata();
  assert.equal(metadata.format, 'webp');
  assert.deepEqual([metadata.width, metadata.height], [1, 1]);
  assert.equal(metadata.exif, undefined);
  assert.ok(normalized.byteLength <= 512 * 1024);
});

test('profile photos strip EXIF and apply camera orientation before resizing', async () => {
  const jpeg = await sharp({
    create: { width: 2, height: 1, channels: 3, background: { r: 30, g: 120, b: 210 } },
  })
    .jpeg()
    .withMetadata({ orientation: 6, exif: { IFD0: { Make: 'CareerScope test camera' } } })
    .toBuffer();
  const source = await sharp(jpeg).metadata();
  assert.equal(source.orientation, 6);
  assert.ok(source.exif);

  const normalized = await normalizeProfilePhoto(jpeg, 'image/jpeg');
  const result = await sharp(normalized).metadata();
  assert.equal(result.format, 'webp');
  assert.deepEqual([result.width, result.height], [1, 2]);
  assert.equal(result.exif, undefined);
  assert.equal(result.icc, undefined);
});

test('profile photos reject animated images, pixel-limit violations, and output-limit violations', async () => {
  const animatedWebp = await sharp(Buffer.from([255, 0, 0, 255, 0, 0, 0, 255]), {
    raw: { width: 1, height: 2, channels: 4, pageHeight: 1 },
  })
    .webp({ delay: [100, 100], loop: 0 })
    .toBuffer();
  assert.equal((await sharp(animatedWebp, { animated: true }).metadata()).pages, 2);
  await assert.rejects(normalizeProfilePhoto(animatedWebp, 'image/webp'), InvalidProfilePhoto);

  const oversizedDimensions = await sharp({
    create: {
      width: 4001,
      height: 4000,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .png()
    .toBuffer();
  assert.ok(oversizedDimensions.length < 5 * 1024 * 1024);
  await assert.rejects(
    normalizeProfilePhoto(oversizedDimensions, 'image/png'),
    InvalidProfilePhoto,
  );
  await assert.rejects(normalizeProfilePhoto(transparentPng, 'image/png', 1), InvalidProfilePhoto);
});

test('profile photo decoding rejects unsupported, mismatched, malformed and oversized input', async () => {
  await assert.rejects(normalizeProfilePhoto(transparentPng, 'image/svg+xml'), InvalidProfilePhoto);
  await assert.rejects(normalizeProfilePhoto(transparentPng, 'image/jpeg'), InvalidProfilePhoto);
  await assert.rejects(
    normalizeProfilePhoto(Buffer.from('not an image'), 'image/png'),
    InvalidProfilePhoto,
  );
  await assert.rejects(
    normalizeProfilePhoto(Buffer.alloc(5 * 1024 * 1024 + 1), 'image/png'),
    InvalidProfilePhoto,
  );
  const exactLimit = Buffer.concat([
    transparentPng,
    Buffer.alloc(5 * 1024 * 1024 - transparentPng.byteLength),
  ]);
  assert.equal(exactLimit.byteLength, 5 * 1024 * 1024);
  assert.ok((await normalizeProfilePhoto(exactLimit, 'image/png')).byteLength <= 512 * 1024);
});
