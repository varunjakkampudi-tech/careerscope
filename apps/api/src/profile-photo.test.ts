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
});
