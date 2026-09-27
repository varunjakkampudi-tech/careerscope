import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { derivedResumeSchema } from '@job-radar/shared';
import { maximumResumeBytes } from './storage.js';

export const maximumResumeText = 160_000;
export const parsedResumeSchema = z
  .object({
    format: z.enum(['pdf', 'docx']),
    text: z.string().min(40).max(maximumResumeText),
    derived: derivedResumeSchema.strict(),
  })
  .strict();

let active = false;

export class ResumeDocumentError extends Error {
  constructor() {
    super('Resume rejected by isolated parser');
  }
}

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
        new URL('../../../../node_modules/', import.meta.url),
        // package.json at each workspace package's root, not just its
        // dist/, because these are npm workspace symlinks: the permission
        // model checks the resolved real path, and ESM reads package.json
        // at the package root before it ever gets to dist/. Granted as the
        // whole package directory, not just package.json: narrowing to the
        // exact file broke on Windows (its symlink/realpath resolution
        // under --permission does not match Linux here), and this runs in
        // both places during development, not only in the Linux CI/prod
        // target.
        new URL('../../../../packages/resume/', import.meta.url),
        new URL('../../../../packages/shared/', import.meta.url),
      ].map((url) => fileURLToPath(url));
      const child = spawn(
        process.execPath,
        [
          '--permission',
          '--max-old-space-size=192',
          '--disable-proto=throw',
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
