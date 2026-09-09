import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { join } from 'node:path';
import process from 'node:process';
import { pageFiles } from './stage-pages.mjs';

const root = fileURLToPath(new URL('../mobile-site/', import.meta.url));
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  const name = path === '/' ? 'index.html' : path.slice(1);
  if (!pageFiles.includes(name)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const content = await readFile(join(root, name));
    const type = name.endsWith('.html')
      ? 'text/html'
      : name.endsWith('.css')
        ? 'text/css'
        : name.endsWith('.svg')
          ? 'image/svg+xml'
          : name.endsWith('.json')
            ? 'application/json'
            : name.endsWith('.xml')
              ? 'application/xml'
              : name.endsWith('.txt')
                ? 'text/plain'
                : 'text/javascript';
    response.setHeader('Content-Type', type);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.end(content);
  } catch {
    response.writeHead(404).end();
  }
});
server.listen(Number(process.env.PAGES_PREVIEW_PORT || 5176), '127.0.0.1', () => {
  process.stdout.write(`Static Pages preview: http://127.0.0.1:${server.address().port}/\n`);
});
