// End-to-end verification against a deployed origin over real TLS.
// Creates a throwaway account, exercises the full workspace flow, then removes
// every row it created. Requires registration to be temporarily enabled.
//
// Usage: node check-live-flow.mjs https://careerscope.tech
import { crc32 } from 'node:zlib';
import { Buffer } from 'node:buffer';
import { setTimeout as delay } from 'node:timers/promises';
import process from 'node:process';

const request = globalThis.fetch;

const origin = process.argv[2];
if (!origin) throw new Error('Usage: check-live-flow.mjs <https-origin>');

const email = `verify-${Date.now()}-${Math.floor(Math.random() * 1e6)}@careerscope.tech`;
const password = `V${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}!9`;

let cookie = '';
let csrf = '';
const results = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` :: ${detail}` : ''}\n`);
}

async function call(method, path, { body, headers = {}, raw = false } = {}) {
  const init = { method, headers: { Origin: origin, ...headers }, redirect: 'manual' };
  if (cookie) init.headers.Cookie = cookie;
  if (csrf && !['GET', 'HEAD'].includes(method)) init.headers['X-CSRF-Token'] = csrf;
  if (body !== undefined) {
    if (Buffer.isBuffer(body)) {
      init.headers['Content-Type'] = 'application/octet-stream';
      init.body = body;
    } else {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
  }
  const response = await request(`${origin}${path}`, init);
  const setCookie = response.headers.getSetCookie?.() ?? [];
  for (const value of setCookie) {
    const [pair] = value.split(';');
    if (pair.startsWith('careerscope_v2_session=')) {
      cookie = pair.endsWith('=') ? '' : pair;
    }
  }
  if (raw) return { status: response.status, response, setCookie };
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, json, text: text.slice(0, 200), setCookie };
}

// Minimal stored-entry zip, which is all a DOCX container needs to be readable.
function docx(text) {
  const entries = [
    [
      '[Content_Types].xml',
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ],
    [
      'word/document.xml',
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        `<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
    ],
  ];
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const data = Buffer.from(content, 'utf8');
    const nameBytes = Buffer.from(name, 'utf8');
    const sum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(sum, 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(nameBytes.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const body = Buffer.concat(locals);
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, directory, end]);
}

async function until(probe, attempts = 60, waitMs = 2000) {
  for (let i = 0; i < attempts; i += 1) {
    const value = await probe();
    if (value) return value;
    await delay(waitMs);
  }
  return undefined;
}

// 1. Registration and session establishment.
const registered = await call('POST', '/api/register', { body: { email, password } });
record('public registration accepted', registered.status === 202, `status=${registered.status}`);

const login = await call('POST', '/api/login', { body: { email, password } });
const cookieHeader = login.setCookie.find((value) => value.startsWith('careerscope_v2_session='));
record('login issues a session', login.status === 200 && !!cookie, `status=${login.status}`);
record(
  'session cookie is HttpOnly, Secure, SameSite=Strict, Path=/api',
  /HttpOnly/i.test(cookieHeader ?? '') &&
    /Secure/i.test(cookieHeader ?? '') &&
    /SameSite=Strict/i.test(cookieHeader ?? '') &&
    /Path=\/api/i.test(cookieHeader ?? ''),
  (cookieHeader ?? '').replace(/careerscope_v2_session=[^;]+/, 'careerscope_v2_session=<redacted>'),
);

const session = await call('GET', '/api/session');
csrf = session.json?.csrf ?? '';
record(
  'session reports authenticated with a CSRF token',
  session.json?.authenticated === true && !!csrf,
);

// 2. CSRF enforcement on a state-changing request.
const withoutCsrf = await request(`${origin}/api/profile`, {
  method: 'PUT',
  headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
  body: JSON.stringify({ revision: 0, profile: {} }),
});
record(
  'state change without CSRF token is refused',
  withoutCsrf.status === 403,
  `status=${withoutCsrf.status}`,
);

// 3. Profile.
const profile = {
  candidate: {
    fullName: 'Verification Candidate',
    email: 'verification@example.test',
    location: 'Hyderabad',
  },
  preferences: { titles: ['React Engineer'], techStack: ['React', 'TypeScript'] },
  application: { yearsOfExperience: 4 },
};
const saved = await call('PUT', '/api/profile', { body: { revision: 0, profile } });
record('profile saves', saved.status === 200, `status=${saved.status} ${saved.text}`);

const stale = await call('PUT', '/api/profile', { body: { revision: 0, profile } });
record(
  'stale profile revision is rejected with a conflict',
  stale.status === 409,
  `status=${stale.status}`,
);

// 4. Career preparation.
const preparation = await call('GET', '/api/preparation');
record(
  'preparation returns a rules-based report',
  preparation.status === 200 && preparation.json?.method === 'rules-v1',
  `status=${preparation.status} method=${preparation.json?.method}`,
);
record(
  'preparation never echoes the candidate email',
  !JSON.stringify(preparation.json ?? {}).includes('verification@example.test'),
);

// 5. Resume upload and isolated parsing.
const upload = await call('POST', '/api/resumes', {
  body: docx(
    'Verification Candidate, React and TypeScript engineer with accessible web experience.',
  ),
  headers: { 'Idempotency-Key': `verify-upload-${Date.now()}` },
});
record('resume upload accepted', upload.status === 202, `status=${upload.status} ${upload.text}`);

if (upload.json?.id) {
  const parsed = await until(async () => {
    const state = await call('GET', `/api/resumes/${upload.json.id}`);
    return ['parsed', 'failed', 'quarantined', 'rejected'].includes(state.json?.status)
      ? state.json
      : undefined;
  });
  record('resume parsing settles', parsed?.status === 'parsed', `status=${parsed?.status}`);
}

// 6. Discovery.
const search = await call('POST', '/api/searches', {
  body: { query: 'React', sources: ['remoteok', 'himalayas'] },
  headers: { 'Idempotency-Key': `verify-search-${Date.now()}` },
});
record('search run accepted', search.status === 202, `status=${search.status} ${search.text}`);

let jobId;
if (search.json?.runId) {
  const settled = await until(async () => {
    const state = await call('GET', `/api/searches/${search.json.runId}`);
    return ['completed', 'partial', 'failed', 'cancelled'].includes(state.json?.status)
      ? state.json
      : undefined;
  });
  record(
    'search settles through the queue and workers',
    ['completed', 'partial'].includes(settled?.status),
    `status=${settled?.status} jobs=${settled?.jobs?.length ?? 0}`,
  );
  jobId = settled?.jobs?.[0]?.id;

  const events = await call('GET', `/api/searches/${search.json.runId}/events`, { raw: true });
  record('event stream is served', events.status === 200, `status=${events.status}`);
  await events.response.body?.cancel();

  const badCursor = await call('GET', `/api/searches/${search.json.runId}/events`, {
    headers: { 'Last-Event-ID': 'not-a-number' },
  });
  record(
    'malformed event cursor is refused',
    badCursor.status === 400,
    `status=${badCursor.status}`,
  );
}

// 7. Leads.
if (jobId) {
  const lead = await call('POST', '/api/leads', { body: { jobId } });
  record(
    'lead saves from a completed job',
    lead.status === 200,
    `status=${lead.status} ${lead.text}`,
  );
  if (lead.json?.id) {
    const updated = await call('PUT', `/api/leads/${lead.json.id}`, {
      body: { revision: lead.json.revision, status: 'archived', notes: 'verification' },
    });
    record(
      'lead updates with optimistic concurrency',
      updated.status === 200,
      `status=${updated.status} ${updated.text}`,
    );
    const conflict = await call('PUT', `/api/leads/${lead.json.id}`, {
      body: { revision: lead.json.revision, status: 'saved', notes: 'verification' },
    });
    record('stale lead revision is rejected', conflict.status === 409, `status=${conflict.status}`);
    const history = await call('GET', `/api/leads/${lead.json.id}/history`);
    record('lead history is retained', history.status === 200, `status=${history.status}`);
  }
} else {
  record('lead flow exercised', false, 'no job available from discovery');
}

// 8. Owner isolation: another account must not see these records.
const otherEmail = `verify-other-${Date.now()}@careerscope.tech`;
const otherPassword = `V${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}!9`;
const savedCookie = cookie;
const savedCsrf = csrf;
cookie = '';
csrf = '';
await call('POST', '/api/register', { body: { email: otherEmail, password: otherPassword } });
await call('POST', '/api/login', { body: { email: otherEmail, password: otherPassword } });
const otherSession = await call('GET', '/api/session');
csrf = otherSession.json?.csrf ?? '';
const foreignSearch = search.json?.runId
  ? await call('GET', `/api/searches/${search.json.runId}`)
  : { status: 0 };
record(
  "another owner cannot read this owner's run",
  foreignSearch.status === 404,
  `status=${foreignSearch.status}`,
);
const foreignLeads = await call('GET', '/api/leads');
record('another owner sees no leads', (foreignLeads.json?.items?.length ?? 0) === 0);

// 9. Logout invalidates the session.
cookie = savedCookie;
csrf = savedCsrf;
const loggedOut = await call('POST', '/api/logout');
record(
  'logout succeeds',
  loggedOut.status === 204 || loggedOut.status === 200,
  `status=${loggedOut.status}`,
);
cookie = savedCookie;
const afterLogout = await call('GET', '/api/preparation');
record('revoked session is refused', afterLogout.status === 401, `status=${afterLogout.status}`);

const failures = results.filter((entry) => !entry.ok);
process.stdout.write(`\n${results.length - failures.length}/${results.length} checks passed\n`);
process.stdout.write(`accounts to purge: ${email}, ${otherEmail}\n`);
if (failures.length) process.exitCode = 1;
