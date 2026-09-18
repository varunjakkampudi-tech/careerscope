import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { fromBufferPromise } from 'yauzl';
import DOMMatrix from '@thednp/dommatrix';
import { parseResume, detectFormat } from '../../../../packages/resume/dist/index.js';
import { maximumResumeBytes } from './storage.js';
import { maximumResumeText, parsedResumeSchema } from './resume-parser.js';

async function checkDocx(data: Buffer) {
  const archive = await fromBufferPromise(data, {
    lazyEntries: true,
    validateEntrySizes: true,
    strictFileNames: true,
  });
  const names = new Set<string>();
  let expanded = 0;
  try {
    if (archive.entryCount > 200) throw new Error('Too many archive entries');
    for await (const entry of archive.eachEntry()) {
      const name = entry.fileName.toLowerCase();
      if (
        names.has(name) ||
        name.includes('vbaproject') ||
        name.startsWith('word/embeddings/') ||
        entry.isEncrypted()
      ) {
        throw new Error('Unsupported archive entry');
      }
      names.add(name);
      expanded += entry.uncompressedSize;
      if (
        expanded > 20 * 1024 * 1024 ||
        entry.uncompressedSize > Math.max(1, entry.compressedSize) * 100
      ) {
        throw new Error('Archive expansion limit exceeded');
      }
      const stream = await archive.openReadStreamPromise(entry);
      let actual = 0;
      try {
        for await (const chunk of stream) {
          actual += chunk.length;
          if (actual > entry.uncompressedSize) throw new Error('Invalid archive entry size');
        }
        if (actual !== entry.uncompressedSize) throw new Error('Invalid archive entry size');
      } finally {
        stream.destroy();
      }
    }
    if (!names.has('[content_types].xml') || !names.has('word/document.xml'))
      throw new Error('Not a DOCX document');
  } finally {
    archive.close();
  }
}

async function main() {
  if (
    !process.allowedNodeEnvironmentFlags.has('--allow-net') ||
    !process.permission ||
    process.permission.has('net') ||
    process.permission.has('child') ||
    process.permission.has('fs.write')
  ) {
    throw Object.assign(new Error('Parser permissions unavailable'), {
      code: 'PARSER_UNAVAILABLE',
    });
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > maximumResumeBytes) throw new Error('Input limit exceeded');
    chunks.push(Buffer.from(chunk));
  }
  const data = Buffer.concat(chunks);
  const format = detectFormat(data);
  if (format === 'docx') await checkDocx(data);
  else if (format === 'pdf') {
    Object.defineProperty(globalThis, 'DOMMatrix', { value: DOMMatrix });
    const require = createRequire(
      fileURLToPath(new URL('../../../../package.json', import.meta.url)),
    );
    const { PDFParse } = require('pdf-parse') as {
      PDFParse: new (input: { data: Uint8Array }) => {
        getInfo(): Promise<{ total: number }>;
        destroy(): Promise<void>;
      };
    };
    const parser = new PDFParse({ data: Uint8Array.from(data) });
    try {
      const info = await parser.getInfo();
      if (!Number.isInteger(info.total) || info.total < 1 || info.total > 50)
        throw new Error('PDF page limit exceeded');
    } finally {
      await parser.destroy();
    }
  } else throw new Error('Unsupported format');
  const parsed = await parseResume(data, Number(process.argv[2]));
  if (parsed.text.length > maximumResumeText) throw new Error('Text limit exceeded');
  const output = JSON.stringify(parsedResumeSchema.parse(parsed));
  if (Buffer.byteLength(output) > 1_048_576) throw new Error('Output limit exceeded');
  process.stdout.write(output);
}

main().catch((error: unknown) => {
  const unavailable =
    error instanceof Error &&
    'code' in error &&
    ['PARSER_UNAVAILABLE', 'ERR_ACCESS_DENIED', 'MODULE_NOT_FOUND'].includes(String(error.code));
  process.stdout.write(
    JSON.stringify({ error: unavailable ? 'parser_unavailable' : 'invalid_document' }),
  );
  process.exitCode = 1;
});
