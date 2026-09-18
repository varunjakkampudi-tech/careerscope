import { z } from 'zod';

export const maximumResumeBytes = 5 * 1024 * 1024;

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

export const resumeUploadMetadataSchema = objectSchema.pick({
  sha256: true,
  bytes: true,
  contentType: true,
});

/**
 * Contract every resume store must satisfy. The shipped implementation is the
 * encrypted filesystem store; an S3-compatible adapter was evaluated and removed
 * because nothing used it.
 */
export type ResumeObjectStore = {
  readonly bucket: string;
  initialize(signal?: AbortSignal): Promise<void>;
  put(object: ResumeObject, body: Uint8Array, signal?: AbortSignal): Promise<string>;
  get(object: ResumeObject, version: string, signal?: AbortSignal): Promise<Buffer>;
  recoverVersion(object: ResumeObject, signal?: AbortSignal): Promise<string | null>;
};
