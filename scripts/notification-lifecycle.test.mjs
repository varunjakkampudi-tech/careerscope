import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { observeNotificationPage } from './notification-lifecycle.ts';

const require = createRequire(import.meta.url);
const { validRecord, observeServer, observeClient } = require('./notification-lifecycle.mjs');
const id = '00000000-0000-4000-8000-000000000001';
const helper = fileURLToPath(new URL('./notification-lifecycle.mjs', import.meta.url));
test('diagnostics reject unapproved fields and invalid identifiers', () => {
  const record = {
    id,
    method: 'GET',
    path: '/api/notifications',
    layer: 'cdp',
    stage: 'request',
    at: 1,
  };
  assert.equal(validRecord(record), true);
  for (const extra of [
    { headers: {} },
    { payload: 'synthetic' },
    { cookie: 'synthetic' },
    { id: 'not-a-uuid' },
    { layer: 'unknown' },
    { status: 999 },
  ]) {
    assert.equal(validRecord({ ...record, ...extra }), false);
  }
});

test('passive HTTP observers retain real status/body and record completion without private fields', () => {
  const output = execFileSync(
    process.execPath,
    [
      '-e',
      `
    const assert=require('node:assert/strict'), http=require('node:http');
    const {installNextDiagnostics}=require(${JSON.stringify(helper)});
    const original=http.request, restore=installNextDiagnostics();
    const server=http.createServer((req,res)=>{res.writeHead(201,{'content-type':'text/plain'});res.end('private-body-sentinel');});
    server.listen(0,'127.0.0.1',()=>{
      const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/api/notifications',method:'GET',headers:{'x-careerscope-ui-lifecycle-id':${JSON.stringify(id)},authorization:'private-auth-sentinel',cookie:'private-cookie-sentinel'}},res=>{
        let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>{
          assert.equal(res.statusCode,201);assert.equal(body,'private-body-sentinel');
          restore();assert.equal(http.request,original);server.close();
        });
      });req.end();
    });
  `,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DEPLOYMENT_ENVIRONMENT: 'development',
        CAREERSCOPE_NOTIFICATION_PROXY_DIAGNOSTICS: '',
      },
    },
  );
  assert.doesNotMatch(output, /private-(?:body|auth|cookie)-sentinel/);
  const records = output
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line.slice('CS_NOTIFICATION_LIFECYCLE '.length)));
  assert.ok(records.every(validRecord));
  assert.ok(
    records.some(
      (r) => r.layer === 'next-ingress' && r.stage === 'finish' && r.status === 201 && r.complete,
    ),
  );
  assert.ok(records.some((r) => r.layer === 'next-upstream' && r.stage === 'end' && r.complete));
});

test('preload is inert by default and refuses a production environment', () => {
  execFileSync(
    process.execPath,
    [
      '-e',
      `const h=require('node:http'), before=h.request;require(${JSON.stringify(helper)});require('node:assert/strict').equal(h.request,before);`,
    ],
    { env: { ...process.env, CAREERSCOPE_NOTIFICATION_PROXY_DIAGNOSTICS: '' } },
  );
  const blocked = spawnSync(process.execPath, ['--import', helper, '-e', ''], {
    env: {
      ...process.env,
      CAREERSCOPE_NOTIFICATION_PROXY_DIAGNOSTICS: '1',
      NODE_ENV: 'production',
      DEPLOYMENT_ENVIRONMENT: 'production',
    },
  });
  assert.notEqual(blocked.status, 0);
});

test('passive error monitoring preserves otherwise-unhandled error propagation', () => {
  const request = Object.assign(new EventEmitter(), {
    headers: { 'x-careerscope-ui-lifecycle-id': id },
    method: 'GET',
    url: '/api/notifications',
  });
  const response = new EventEmitter();
  observeServer(request, response, 'fastify');
  const client = Object.assign(new EventEmitter(), {
    getHeader: () => id,
    method: 'GET',
    path: '/api/notifications',
  });
  observeClient(client);
  for (const target of [request, response, client]) {
    const failure = new Error('synthetic observer propagation probe');
    assert.equal(target.listenerCount('error'), 0);
    assert.throws(
      () => target.emit('error', failure),
      (caught) => caught === failure,
    );
  }
});

test('browser correlation preserves fetch options and only decorates the target GET', async () => {
  let initScript;
  const page = {
    addInitScript: async (fn) => {
      initScript = fn;
    },
    on: () => {},
    context: () => ({ newCDPSession: async () => ({ send: async () => {}, on: () => {} }) }),
  };
  await observeNotificationPage(page, 'http://localhost:5280');
  const calls = [];
  const pending = Promise.resolve(new Response('synthetic'));
  const context = {
    URL,
    Request,
    Headers,
    location: { href: 'http://localhost:5280/dashboard' },
    crypto: { randomUUID: () => id },
    fetch: (...args) => {
      calls.push(args);
      return pending;
    },
  };
  runInNewContext('(' + initScript.toString() + ')("http://localhost:5280")', context);
  const signal = new AbortController().signal;
  const options = { signal, credentials: 'same-origin', headers: { 'x-existing': 'synthetic' } };
  assert.equal(context.fetch('/api/notifications', options), pending);
  assert.equal(calls[0][1].signal, signal);
  assert.equal(calls[0][1].credentials, 'same-origin');
  assert.equal(calls[0][1].headers.get('x-existing'), 'synthetic');
  assert.equal(calls[0][1].headers.get('x-careerscope-ui-lifecycle-id'), id);
  for (const url of ['/api/session', 'https://example.test/api/notifications', 'http://[']) {
    context.fetch(url, options);
    assert.equal(calls.at(-1)[1], options);
  }
  const mutation = { ...options, method: 'POST' };
  context.fetch('/api/notifications', mutation);
  assert.equal(calls.at(-1)[1], mutation);
});

test('CDP keeps exact-request events before header correlation and never joins by URL', async () => {
  const handlers = new Map();
  const page = {
    addInitScript: async () => {},
    on: () => {},
    context: () => ({
      newCDPSession: async () => ({
        send: async () => {},
        on: (name, fn) => handlers.set(name, fn),
      }),
    }),
  };
  const records = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = function (chunk, ...args) {
    if (typeof chunk === 'string' && chunk.startsWith('CS_NOTIFICATION_LIFECYCLE ')) {
      records.push(JSON.parse(chunk.slice('CS_NOTIFICATION_LIFECYCLE '.length)));
      return true;
    }
    return Reflect.apply(originalWrite, this, [chunk, ...args]);
  };
  try {
    await observeNotificationPage(page, 'http://localhost:5280');
    for (const requestId of ['correlated', 'same-url-different-request']) {
      handlers.get('Network.requestWillBeSent')({
        requestId,
        request: { method: 'GET', url: 'http://localhost:5280/api/notifications', headers: {} },
      });
      handlers.get('Network.responseReceived')({ requestId, response: { status: 200 } });
      handlers.get('Network.responseReceivedExtraInfo')({ requestId, statusCode: 200 });
      handlers.get('Network.dataReceived')({
        requestId,
        timestamp: 123.456,
        dataLength: 4096,
        encodedDataLength: 2048,
      });
      handlers.get('Network.loadingFinished')({ requestId });
    }
    assert.equal(records.length, 0);
    handlers.get('Network.requestWillBeSentExtraInfo')({
      requestId: 'correlated',
      headers: { 'x-careerscope-ui-lifecycle-id': id },
    });
    assert.deepEqual(
      records.map((record) => record.stage),
      ['request', 'response', 'response-headers', 'data-received', 'finish'],
    );
    assert.equal(records.find((record) => record.stage === 'response-headers')?.status, 200);
    assert.ok(records.every((record) => record.id === id && validRecord(record)));
    assert.equal(records.find((record) => record.stage === 'data-received')?.at > 0, true);
    assert.ok(
      records.every((record) => !('dataLength' in record) && !('encodedDataLength' in record)),
    );
  } finally {
    process.stdout.write = originalWrite;
  }
});
