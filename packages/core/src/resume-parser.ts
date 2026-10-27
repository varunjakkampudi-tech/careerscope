/**
 * Runs the resume parser in a locked-down child process (`resume-parser-child.ts`) and validates its
 * output. Used by `resumes.ts`; the parsing logic itself is in `@careerscope/resume`.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { derivedResumeSchema } from '@careerscope/shared';
import { maximumResumeBytes } from './storage.js';

/** Largest accepted extracted text, in characters. */
export const maximumResumeText = 160_000;
/** Shape the child must return. `.strict()` rejects extra fields from the untrusted process. */
export const parsedResumeSchema = z
  .object({
    format: z.enum(['pdf', 'docx']),
    text: z.string().min(40).max(maximumResumeText),
    derived: derivedResumeSchema.strict(),
  })
  .strict();

// Only one parse runs per process at a time, which bounds memory used by untrusted documents.
let active = false;

/** The document itself is unreadable or unsafe, as opposed to a transient parser failure. */
export class ResumeDocumentError extends Error {
  constructor() {
    super('Resume rejected by isolated parser');
  }
}

/**
 * Parses a resume in a child process started with Node's permission model: read access only to the
 * built packages and dependencies, an empty environment, a 192 MB heap, no stderr, and a 30 second
 * timeout. Output over 1 MiB, cancellation, or a timeout kills the child. Throws `ResumeDocumentError`
 * for a rejected document and a generic error for infrastructure failures. `now` fixes the clock used for experience maths.
 */
export async function parseResumeIsolated(body: Uint8Array, now: number, signal?: AbortSignal) {
  z.number().int().min(0).max(8_640_000_000_000_000).parse(now);
  signal?.throwIfAborted();
  if (!body.byteLength || body.byteLength > maximumResumeBytes)
    throw new Error('Invalid resume size');
  if (active) throw new Error('Resume parser is busy');
  active = true;
  try {
    const data = Buffer.from(body);
    return await new Promise<z.infer<typeof parsedResumeSchema>>((resolve, reject) => {
      const readable = [
        new URL('../dist/', import.meta.url),
        new URL('../../../node_modules/', import.meta.url),
        new URL('../../../node_modules/', import.meta.url),
        // The whole directory of each workspace package, not just its dist/ or
        // package.json. These are npm workspace symlinks: the permission model
        // checks the resolved real path, and ESM reads package.json at the package
        // root before it reaches dist/. Granting only the exact file fails on
        // Windows, where symlink and realpath resolution under --permission
        // differs from Linux.
        new URL('../../resume/', import.meta.url),
        new URL('../../shared/', import.meta.url),
      ].map((url) => fileURLToPath(url));
      const child = spawn(
        process.execPath,
        [
          '--permission',
          '--max-old-space-size=192',
          // `--disable-proto` is deliberately not set: mammoth's DOCX reader uses the
          // `__proto__` accessor internally, and disabling it makes valid DOCX files
          // fail. The child is still isolated by the permission model and gets no
          // network or child-process grant.
          ...readable.map((path) => `--allow-fs-read=${path}`),
          fileURLToPath(new URL('../dist/resume-parser-child.js', import.meta.url)),
          String(now),
        ],
        { env: {}, cwd: '/', stdio: ['pipe', 'pipe', 'ignore'] },
      );
      const chunks: Buffer[] = [];
      let bytes = 0;
      let failure: Error | undefined;
      const fail = (error: Error) => {
        failure ??= error;
        child.kill('SIGKILL');
      };
      const abort = () => fail(new Error('Resume parsing cancelled'));
      const timeout = setTimeout(() => fail(new Error('Resume parsing timed out')), 30_000);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      child.on('error', () => fail(new Error('Resume parser unavailable')));
      child.stdin.on('error', () => fail(new Error('Resume parser input failed')));
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1_048_576) fail(new Error('Resume parser output exceeded limit'));
        else chunks.push(chunk);
      });
      child.on('close', (code) => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        if (failure) return reject(failure);
        if (code !== 0) {
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (result.error === 'invalid_document') return reject(new ResumeDocumentError());
          } catch {
            return reject(new Error('Resume parser unavailable'));
          }
          return reject(new Error('Resume parser unavailable'));
        }
        try {
          resolve(parsedResumeSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
        } catch {
          reject(new Error('Invalid isolated parser result'));
        }
      });
      child.stdin.end(data);
    });
  } finally {
    active = false;
  }
}
