/**
 * Resume upload and parsing.
 *
 * The only endpoint that accepts a file, and therefore the one that gets the
 * most attention. Four things guard it, in this order:
 *
 *  1. **A size cap enforced by the parser, not by us.** `@fastify/multipart` is
 *     configured with `MAX_RESUME_BYTES` in `app.ts`, so an oversized upload is
 *     cut off at the socket. A cap checked after buffering is not a cap.
 *  2. **The format comes from the bytes.** `detectFormat` reads the magic number.
 *     The filename and the browser's `Content-Type` are attacker-controlled and
 *     are used only for display.
 *  3. **The stored filename is generated.** `safeFilename` strips directory
 *     separators and the file is written under a UUID, so nothing the client
 *     sends can steer the write out of `<dataDir>/resumes`.
 *  4. **Parsing happens before storage.** A file that cannot be read is rejected
 *     without ever reaching the disk — there is no value in keeping a resume the
 *     app cannot use, and every byte not written is one that cannot leak.
 *
 * The response carries the derived fields so the onboarding form can prefill
 * itself in the same round trip. It does *not* carry the extracted text: it can
 * run to tens of kilobytes, the browser has no use for it, and it is the most
 * sensitive thing in the payload.
 */

import { parseResume, ResumeParseError } from '@job-radar/resume';
import { ALLOWED_RESUME_MIME, MAX_RESUME_BYTES } from '@job-radar/shared';
import type { MultipartFile } from '@fastify/multipart';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiProblem } from '../errors.js';
import { safeFilename } from '../util/ids.js';
import { now } from '../util/time.js';
import type { RouteOptions } from './index.js';

export async function resumeRoutes(app: FastifyInstance, options: RouteOptions): Promise<void> {
  const { repos } = options.container;

  app.post('/resume', async (request, reply) => {
    const upload = await readUpload(request);
    const bytes = await collect(upload);

    let parsed;
    try {
      parsed = await parseResume(bytes);
    } catch (error) {
      if (error instanceof ResumeParseError) {
        // The parser's own codes are already user-facing — "File is not a PDF or
        // DOCX", "No readable text" — and map onto distinct fixes, so they are
        // passed through rather than flattened into one generic message.
        throw new ApiProblem(415, `resume_${error.code}`, error.message);
      }
      throw error;
    }

    const stored = await repos.resumes.store(
      {
        filename: safeFilename(upload.filename),
        // Recorded from the detected format, not from the upload's declared
        // type, so what is stored matches what is actually in the file.
        mimeType: parsed.format === 'pdf' ? 'application/pdf' : ALLOWED_RESUME_MIME[1],
        bytes,
        text: parsed.text,
        derived: parsed.derived,
      },
      now(),
    );

    // Attaching immediately is what makes the resume usable without a second
    // request. A first-run upload has no profile to attach to yet; onboarding
    // sends `resumeId` with the profile it then creates.
    if (repos.profiles.exists()) repos.profiles.attachResume(stored.id, now());

    return reply.status(201).send({ resume: stored, derived: parsed.derived });
  });

  app.get('/resume', async () => ({ resumes: repos.resumes.list() }));

  app.get('/resume/:id', async (request) => {
    const { id } = request.params as { id: string };
    const resume = repos.resumes.get(id);
    if (!resume) throw ApiProblem.notFound('Resume', id);
    return { resume };
  });

  /**
   * The original file back.
   *
   * `Content-Disposition: attachment` and a fixed content type, never the stored
   * filename's extension — a browser that decides to render an upload inline is
   * how a stored file becomes a stored XSS.
   */
  app.get('/resume/:id/file', async (request, reply) => {
    const { id } = request.params as { id: string };
    const resume = repos.resumes.get(id);
    if (!resume) throw ApiProblem.notFound('Resume', id);

    const bytes = await repos.resumes.file(id);
    if (!bytes) {
      throw new ApiProblem(410, 'file_missing', 'The stored file is no longer on disk');
    }

    return reply
      .header('content-type', resume.mimeType)
      .header('content-disposition', `attachment; filename="${safeFilename(resume.filename)}"`)
      .header('x-content-type-options', 'nosniff')
      .send(Buffer.from(bytes));
  });

  app.delete('/resume/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const deleted = await repos.resumes.delete(id);
    if (!deleted) throw ApiProblem.notFound('Resume', id);
    return reply.status(204).send();
  });
}

/* -------------------------------------------------------------------------- */
/* Multipart                                                                  */
/* -------------------------------------------------------------------------- */

async function readUpload(request: FastifyRequest): Promise<MultipartFile> {
  if (!request.isMultipart()) {
    throw ApiProblem.unsupportedMedia('Send the resume as multipart/form-data');
  }

  const upload = await request.file();
  if (!upload) throw ApiProblem.badRequest('No file was included in the upload');
  return upload;
}

/**
 * Drains the upload stream into memory.
 *
 * `file.truncated` is the check that matters: `@fastify/multipart` stops reading
 * at the configured limit and sets the flag rather than throwing, so a stream
 * consumed without looking at it yields a *silently truncated* buffer. That
 * buffer would still start with `%PDF`, still parse, and still store — as a
 * corrupted resume nobody would think to re-upload.
 */
async function collect(file: MultipartFile): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of file.file) chunks.push(chunk as Buffer);

  if (file.file.truncated) {
    throw ApiProblem.payloadTooLarge(
      `Resume is larger than ${Math.round(MAX_RESUME_BYTES / 1024 / 1024)} MB`,
    );
  }

  const bytes = Buffer.concat(chunks);
  if (bytes.length === 0) throw ApiProblem.badRequest('The uploaded file is empty');
  return new Uint8Array(bytes);
}
