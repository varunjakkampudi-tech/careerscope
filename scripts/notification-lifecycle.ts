import { createRequire } from 'node:module';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Page } from 'playwright';

type LifecycleEvent = {
  id: string;
  method: 'GET';
  path: '/api/notifications';
  layer: 'playwright' | 'cdp';
  stage:
    'request' | 'response-headers' | 'response' | 'data-received' | 'finish' | 'abort' | 'error';
  at: number;
  status?: number;
  complete?: boolean;
  aborted?: boolean;
};
const diagnostics = createRequire(import.meta.url)('./notification-lifecycle.mjs') as {
  emit: (event: LifecycleEvent) => void;
  observeServer: (request: IncomingMessage, response: ServerResponse, layer: 'fastify') => void;
};
export const observeNotificationServer = diagnostics.observeServer;

export async function observeNotificationPage(page: Page, origin: string) {
  await page.addInitScript((expectedOrigin) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = function (input, init) {
      let url: URL;
      try {
        url = new URL(
          input instanceof Request ? input.url : String(input),
          globalThis.location.href,
        );
      } catch {
        // Retain native fetch's rejection behavior for malformed inputs.
        return originalFetch.call(this, input, init);
      }
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      if (
        url.origin === expectedOrigin &&
        url.pathname === '/api/notifications' &&
        method.toUpperCase() === 'GET'
      ) {
        const headers = new Headers(
          init?.headers ?? (input instanceof Request ? input.headers : undefined),
        );
        headers.set('x-careerscope-ui-lifecycle-id', crypto.randomUUID());
        return originalFetch.call(this, input, { ...init, headers });
      }
      return originalFetch.call(this, input, init);
    };
  }, origin);
  const readId = (headers: Record<string, unknown>) => {
    const id = Object.entries(headers).find(
      ([key]) => key.toLowerCase() === 'x-careerscope-ui-lifecycle-id',
    )?.[1];
    return typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id) ? id : undefined;
  };
  const event = (
    id: string,
    layer: LifecycleEvent['layer'],
    stage: LifecycleEvent['stage'],
    fields: Partial<LifecycleEvent> = {},
  ) =>
    diagnostics.emit({
      id,
      method: 'GET',
      path: '/api/notifications',
      layer,
      stage,
      at: Date.now(),
      ...fields,
    });
  page.on('request', (request) => {
    const id = readId(request.headers());
    if (id) event(id, 'playwright', 'request');
  });
  page.on('response', (response) => {
    const id = readId(response.request().headers());
    if (id) event(id, 'playwright', 'response', { status: response.status() });
  });
  page.on('requestfinished', (request) => {
    const id = readId(request.headers());
    if (id) event(id, 'playwright', 'finish', { complete: true });
  });
  page.on('requestfailed', (request) => {
    const id = readId(request.headers());
    if (id)
      event(id, 'playwright', 'error', {
        aborted: /ERR_ABORTED/.test(request.failure()?.errorText ?? ''),
      });
  });
  const cdp = await page.context().newCDPSession(page);
  const ids = new Map<string, string>();
  const pending = new Map<
    string,
    Array<{ stage: LifecycleEvent['stage']; fields: Partial<LifecycleEvent> }>
  >();
  const record = (
    requestId: string,
    stage: LifecycleEvent['stage'],
    fields: Partial<LifecycleEvent> = {},
  ) => {
    const id = ids.get(requestId);
    const timed = { at: Date.now(), ...fields };
    if (id) event(id, 'cdp', stage, timed);
    else {
      const values = pending.get(requestId) ?? [];
      values.push({ stage, fields: timed });
      pending.set(requestId, values);
    }
  };
  const correlate = (requestId: string, headers: Record<string, unknown>) => {
    const id = readId(headers);
    if (!id) return;
    ids.set(requestId, id);
    for (const value of pending.get(requestId) ?? []) event(id, 'cdp', value.stage, value.fields);
    pending.delete(requestId);
  };
  await cdp.send('Network.enable');
  cdp.on('Network.requestWillBeSent', (value) => {
    if (
      value.request.method !== 'GET' ||
      new URL(value.request.url).pathname !== '/api/notifications'
    )
      return;
    correlate(value.requestId, value.request.headers);
    record(value.requestId, 'request');
  });
  cdp.on('Network.requestWillBeSentExtraInfo', (value) =>
    correlate(value.requestId, value.headers),
  );
  cdp.on('Network.responseReceived', (value) => {
    if (ids.has(value.requestId) || pending.has(value.requestId))
      record(value.requestId, 'response', { status: value.response.status });
  });
  cdp.on('Network.responseReceivedExtraInfo', (value) => {
    if (ids.has(value.requestId) || pending.has(value.requestId))
      record(value.requestId, 'response-headers', { status: value.statusCode });
  });
  cdp.on('Network.dataReceived', (value) => {
    if (ids.has(value.requestId) || pending.has(value.requestId))
      record(value.requestId, 'data-received');
  });
  cdp.on('Network.loadingFinished', (value) => {
    if (ids.has(value.requestId) || pending.has(value.requestId))
      record(value.requestId, 'finish', { complete: true });
  });
  cdp.on('Network.loadingFailed', (value) => {
    if (ids.has(value.requestId) || pending.has(value.requestId))
      record(value.requestId, 'error', { aborted: value.canceled === true });
  });
}
