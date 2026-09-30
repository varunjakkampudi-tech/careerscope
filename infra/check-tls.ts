import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const run = promisify(execFile);
const container = `careerscope-tls-${randomUUID().slice(0, 8)}`;
const domain = 'localhost';
const httpsPort = 18443;
const httpPort = 18080;
const upstreamPort = 18500;
const caddyfile = fileURLToPath(new URL('./Caddyfile.production', import.meta.url));

// Stands in for the API only to prove cookie flags survive the proxy unchanged.
const upstream = createServer((request, response) => {
  if (request.url === '/api/login') {
    response.setHeader(
      'Set-Cookie',
      'careerscope_v2_session=synthetic; HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=28800',
    );
  }
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ path: request.url, forwarded: request.headers }));
});
await new Promise<void>((resolve) => upstream.listen(upstreamPort, '0.0.0.0', resolve));

const fetched = async (url: string, options: RequestInit = {}) => {
  const response = await fetch(url, { ...options, redirect: 'manual' });
  const body = await response.text();
  return { status: response.status, headers: response.headers, body };
};

try {
  await run('docker', [
    'run',
    '-d',
    '--name',
    container,
    '-p',
    `${httpsPort}:443`,
    '-p',
    `${httpPort}:80`,
    '-v',
    `${caddyfile}:/etc/caddy/Caddyfile:ro`,
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--tmpfs',
    '/config:uid=1000',
    '--tmpfs',
    '/data:uid=1000',
    '-e',
    `CAREERSCOPE_DOMAIN=${domain}`,
    '-e',
    'CAREERSCOPE_TLS_MODE=internal',
    '-e',
    `CAREERSCOPE_UPSTREAM=host.docker.internal:${upstreamPort}`,
    '--add-host',
    'host.docker.internal:host-gateway',
    'careerscope:v3-local-proxy',
  ]);

  // Caddy's internal CA is not a public trust root, so verification is disabled
  // for this check only. The production mode uses ACME certificates instead.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  let ready = false;
  for (let attempt = 0; attempt < 40 && !ready; attempt += 1) {
    try {
      await fetched(`https://${domain}:${httpsPort}/api/health`);
      ready = true;
    } catch {
      await delay(500);
    }
  }
  assert.ok(ready, 'TLS listener never became available');

  const secure = await fetched(`https://${domain}:${httpsPort}/api/health`);
  assert.equal(secure.status, 200);
  assert.equal(
    secure.headers.get('strict-transport-security'),
    'max-age=31536000; includeSubDomains',
  );
  assert.equal(secure.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(secure.headers.get('x-frame-options'), 'DENY');
  assert.equal(secure.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(secure.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(secure.headers.get('server'), null);

  // Plain HTTP must never serve the application, only redirect to TLS.
  const insecure = await fetched(`http://${domain}:${httpPort}/api/health`);
  assert.equal(insecure.status, 301);
  assert.equal(insecure.headers.get('location'), `https://${domain}/api/health`);

  // Session cookies must keep Secure, HttpOnly and SameSite through the proxy.
  const login = await fetched(`https://${domain}:${httpsPort}/api/login`, { method: 'POST' });
  const cookie = login.headers.get('set-cookie') ?? '';
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /Secure/i);
  assert.match(cookie, /SameSite=Strict/i);
  assert.match(cookie, /Path=\/api/i);

  // Client-supplied forwarding headers must not reach the application.
  const echoed = await fetched(`https://${domain}:${httpsPort}/api/session`, {
    headers: {
      'X-Forwarded-For': '203.0.113.9',
      'X-Forwarded-Proto': 'http',
      'X-Forwarded-Host': 'evil.example',
    },
  });
  const forwarded = (JSON.parse(echoed.body) as { forwarded: Record<string, string> }).forwarded;
  for (const header of ['x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host']) {
    assert.equal(forwarded[header], undefined, `${header} reached the application`);
  }

  // An unknown server name gets no certificate at all.
  await assert.rejects(fetched(`https://127.0.0.1:${httpsPort}/api/health`));

  // A spoofed Host header on a valid TLS session must still be refused.
  const spoofed = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpsRequest(
      {
        host: '127.0.0.1',
        port: httpsPort,
        servername: domain,
        path: '/api/health',
        headers: { Host: 'evil.example' },
        rejectUnauthorized: false,
      },
      (response) => {
        let body = '';
        response.on('data', (chunk) => (body += String(chunk)));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    request.on('error', reject);
    request.end();
  });
  assert.equal(spoofed.status, 421, `spoofed Host was served: ${spoofed.body.slice(0, 200)}`);

  process.stdout.write(
    'TLS topology: HTTPS served, HTTP redirected, HSTS and security headers set, secure cookie preserved, forwarded headers stripped, foreign host refused\n',
  );
} finally {
  upstream.close();
  await run('docker', ['rm', '-f', container]).catch(() => {});
}
