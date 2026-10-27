/**
 * Resume object metadata schemas and the store contract. Implemented by `file-storage.ts` and used
 * by `resumes.ts`.
 */

import { z } from 'zod';

/** Largest stored resume, in bytes; enforced by `objectSchema` and the upload path. */
export const maximumResumeBytes = 5 * 1024 * 1024;

/** Identity of a stored resume object: owner, resume id, SHA-256 digest, size and content type. */
const objectSchema = z
  .object({
    ownerId: z.string().uuid(),
    resumeId: z.string().uuid(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().min(1).max(maximumResumeBytes),
    contentType: z.enum([
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ]),
  })
  .strict();

export type ResumeObject = z.infer<typeof objectSchema>;

/** The client-supplied subset of `objectSchema`; owner and resume id come from the server. */
export const resumeUploadMetadataSchema = objectSchema.pick({
  sha256: true,
  bytes: true,
  contentType: true,
});

/**
 * Contract every resume store must satisfy. The implementation is the encrypted
 * filesystem store in `file-storage.ts`.
 */
export type ResumeObjectStore = {
  readonly bucket: string;
  initialize(signal?: AbortSignal): Promise<void>;
  put(object: ResumeObject, body: Uint8Array, signal?: AbortSignal): Promise<string>;
  get(object: ResumeObject, version: string, signal?: AbortSignal): Promise<Buffer>;
  recoverVersion(object: ResumeObject, signal?: AbortSignal): Promise<string | null>;
};
