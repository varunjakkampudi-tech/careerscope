// Opt-in diagnostics for an isolated test runner; never loaded by an application.
import http from 'node:http';
import { errorMonitor } from 'node:events';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const prefix = 'CS_NOTIFICATION_LIFECYCLE ';
const header = 'x-careerscope-ui-lifecycle-id';
const path = '/api/notifications';
const validId = (id) => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id);
const stages = new Set([
  'ingress',
  'request',
  'response-headers',
  'response',
  'data-received',
  'end',
  'finish',
  'close',
  'abort',
  'error',
]);

function validRecord(record) {
  return (
    record &&
    validId(record.id) &&
    record.method === 'GET' &&
    record.path === path &&
    ['playwright', 'cdp', 'next-ingress', 'next-upstream', 'fastify'].includes(record.layer) &&
    stages.has(record.stage) &&
    Number.isFinite(record.at) &&
    Object.keys(record).every((key) =>
      ['id', 'method', 'path', 'layer', 'stage', 'at', 'status', 'complete', 'aborted'].includes(
        key,
      ),
    ) &&
    (record.status === undefined ||
      (Number.isInteger(record.status) && record.status >= 100 && record.status <= 599)) &&
    (record.complete === undefined || typeof record.complete === 'boolean') &&
    (record.aborted === undefined || typeof record.aborted === 'boolean')
  );
}

function emit(record) {
  if (!validRecord(record)) throw new Error('Invalid notification lifecycle diagnostic');
  process.stdout.write(prefix + JSON.stringify(record) + '\n');
}

function record(id, layer, stage, fields = {}) {
  emit({ id, method: 'GET', path, layer, stage, at: Date.now(), ...fields });
}

function observeServer(request, response, layer) {
  const id = request.headers[header];
  if (!validId(id) || request.method !== 'GET' || request.url?.split('?')[0] !== path) return;
  record(id, layer, 'ingress');
  request.once('aborted', () => record(id, layer, 'abort', { aborted: true }));
  request.once(errorMonitor, () => record(id, layer, 'error'));
  response.once('finish', () =>
    record(id, layer, 'finish', {
      status: response.statusCode,
      complete: response.writableFinished,
    }),
  );
  response.once('close', () =>
    record(id, layer, 'close', {
      status: response.statusCode,
      complete: response.writableFinished,
      aborted: !response.writableFinished,
    }),
  );
  response.once(errorMonitor, () => record(id, layer, 'error'));
}

function observeClient(request) {
  const id = request.getHeader(header);
  if (!validId(id) || request.method !== 'GET' || request.path?.split('?')[0] !== path) return;
  const layer = 'next-upstream';
  record(id, layer, 'request');
  request.once('response', (response) => {
    record(id, layer, 'response', { status: response.statusCode });
    // Observers only: do not consume, pipe, resume, cancel or replace the body.
    response.once('end', () =>
      record(id, layer, 'end', { status: response.statusCode, complete: response.complete }),
    );
    response.once('aborted', () => record(id, layer, 'abort', { aborted: true }));
    response.once(errorMonitor, () => record(id, layer, 'error'));
    response.once('close', () => record(id, layer, 'close', { complete: response.complete }));
  });
  request.once('finish', () => record(id, layer, 'finish'));
  request.once('close', () => record(id, layer, 'close'));
  request.once('abort', () => record(id, layer, 'abort', { aborted: true }));
  request.once(errorMonitor, () => record(id, layer, 'error'));
}

function installNextDiagnostics() {
  if (process.env.NODE_ENV !== 'test' || process.env.DEPLOYMENT_ENVIRONMENT !== 'development') {
    throw new Error('Notification diagnostics require an isolated test environment');
  }
  const originalEmit = http.Server.prototype.emit;
  const originalRequest = http.request;
  http.Server.prototype.emit = function (event, ...args) {
    if (event === 'request') observeServer(args[0], args[1], 'next-ingress');
    return Reflect.apply(originalEmit, this, [event, ...args]);
  };
  http.request = function (...args) {
    const request = Reflect.apply(originalRequest, this, args);
    observeClient(request);
    return request;
  };
  return () => {
    http.Server.prototype.emit = originalEmit;
    http.request = originalRequest;
  };
}

export { emit, record, observeServer, observeClient, installNextDiagnostics, validRecord };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] !== '--read-log' || !process.argv[3]) throw new Error('Expected --read-log');
  for (const line of readFileSync(process.argv[3], 'utf8').split(/\r?\n/)) {
    if (!line.startsWith(prefix)) continue;
    const parsed = JSON.parse(line.slice(prefix.length));
    emit(parsed);
  }
} else if (process.env.CAREERSCOPE_NOTIFICATION_PROXY_DIAGNOSTICS === '1') {
  installNextDiagnostics();
}
