import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  configuredAiProvider,
  requestCompletion,
  _resetCatalogCacheForTests,
  _setBaseUrlForTests,
  AiProviderError,
} from './ai-provider.js';
import { findElaborationTarget, elaborate } from './ai-assist.js';
import { prepareProfile } from './preparation.js';
import { writableProfileSchema, type ProfileRecord } from './profile.js';

// A minimal real HTTP server standing in for OpenRouter - never a real
// OpenRouter call in these tests, per the acceptance criteria. `handler` is
// swapped per test so each failure mode gets its own precise response.
//
// `res` is typed as ServerResponse DIRECTLY, and that is a fix rather than a
// simplification. It was
// `Parameters<Parameters<typeof createServer>[0]>[1]`, which reads as "the
// second argument of createServer's listener" but is not: `createServer` is
// overloaded, and `Parameters<typeof createServer>` resolves to the FIRST
// overload, whose `[0]` is `ServerOptions`, not a listener. Indexing a
// non-function collapsed the whole expression to `never`, so every mock
// handler in this file was checking nothing at all - `res.writeHead(...)`,
// `res.anything(...)`, all equally accepted. A test file that cannot be
// type-checked is the same class of problem as a test that cannot fail.
async function withMockServer(
  handler: (path: string, res: ServerResponse & { req: IncomingMessage }) => void,
  run: (baseUrl: string) => Promise<void>,
) {
  const server: Server = createServer((req, res) => handler(req.url ?? '', res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  _setBaseUrlForTests(baseUrl);
  try {
    await run(baseUrl);
  } finally {
    _setBaseUrlForTests(undefined);
    _resetCatalogCacheForTests();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const freeCatalog = JSON.stringify({
  data: [{ id: 'test/model:free', pricing: { prompt: '0', completion: '0' } }],
});

test('configuredAiProvider: disabled by default, fails clearly on missing config, rejects the wildcard model', () => {
  assert.equal(configuredAiProvider({}), undefined);
  assert.equal(configuredAiProvider({ AI_ENABLED: 'false' }), undefined);
  assert.throws(() => configuredAiProvider({ AI_ENABLED: 'true' }), /OPENROUTER_API_KEY/);
  assert.throws(
    () => configuredAiProvider({ AI_ENABLED: 'true', OPENROUTER_API_KEY: 'k' }),
    /OPENROUTER_MODEL/,
  );
  assert.throws(
    () =>
      configuredAiProvider({
        AI_ENABLED: 'true',
        OPENROUTER_API_KEY: 'k',
        OPENROUTER_MODEL: 'openrouter/free',
      }),
    /wildcard/,
  );
  assert.throws(
    () =>
      configuredAiProvider({
        AI_ENABLED: 'true',
        OPENROUTER_API_KEY: 'k',
        OPENROUTER_MODEL: 'some/paid-model',
      }),
    /:free/,
  );
  const config = configuredAiProvider({
    AI_ENABLED: 'true',
    OPENROUTER_API_KEY: 'k',
    OPENROUTER_MODEL: 'test/model:free',
  });
  assert.deepEqual(config, { apiKey: 'k', model: 'test/model:free' });
});

test('requestCompletion: success returns the completion text', async () => {
  await withMockServer(
    (path, res) => {
      if (path === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(freeCatalog);
      } else {
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ choices: [{ message: { content: 'Real coaching text.' } }] }));
      }
    },
    async () => {
      const text = await requestCompletion(
        { apiKey: 'k', model: 'test/model:free' },
        { systemPrompt: 'sys', userPrompt: 'user', maxOutputTokens: 50 },
      );
      assert.equal(text, 'Real coaching text.');
    },
  );
});

test('requestCompletion: 401, 402, 429, 5xx each produce a distinct typed failure, never a paid fallback', async () => {
  for (const [status, kind] of [
    [401, 'unauthorized'],
    [402, 'payment_required'],
    [429, 'rate_limited'],
    [500, 'server_error'],
    [503, 'server_error'],
  ] as const) {
    await withMockServer(
      (path, res) => {
        if (path === '/models')
          res.writeHead(200, { 'content-type': 'application/json' }).end(freeCatalog);
        else res.writeHead(status).end('{}');
      },
      async () => {
        await assert.rejects(
          requestCompletion(
            { apiKey: 'k', model: 'test/model:free' },
            { systemPrompt: 'sys', userPrompt: 'user', maxOutputTokens: 50 },
          ),
          (error: unknown) => error instanceof AiProviderError && error.kind === kind,
        );
      },
    );
  }
});

test('requestCompletion: an oversized response body fails safely without unbounded buffering, not as success', async () => {
  // Independent Security review, CS-48 (finding M1): a compromised or
  // misbehaving upstream returning a multi-MB body must fail closed via the
  // byte cap, never buffer the whole thing before any bound applies. This
  // simulates that with a real oversized payload sent from a real server,
  // not a mocked size check.
  const oversizedText = 'x'.repeat(400_000); // well over the 256 KiB cap
  const oversizedBody = JSON.stringify({ choices: [{ message: { content: oversizedText } }] });
  await withMockServer(
    (path, res) => {
      if (path === '/models')
        res.writeHead(200, { 'content-type': 'application/json' }).end(freeCatalog);
      else res.writeHead(200, { 'content-type': 'application/json' }).end(oversizedBody);
    },
    async () => {
      await assert.rejects(
        requestCompletion(
          { apiKey: 'k', model: 'test/model:free' },
          { systemPrompt: 'sys', userPrompt: 'user', maxOutputTokens: 50 },
        ),
        (error: unknown) => error instanceof AiProviderError && error.kind === 'malformed_response',
      );
    },
  );
});

test('requestCompletion: malformed JSON and a well-formed-but-wrong-shape response both fail safely, not as success', async () => {
  await withMockServer(
    (path, res) => {
      if (path === '/models')
        res.writeHead(200, { 'content-type': 'application/json' }).end(freeCatalog);
      else res.writeHead(200, { 'content-type': 'application/json' }).end('not json at all {{{');
    },
    async () => {
      await assert.rejects(
        requestCompletion(
          { apiKey: 'k', model: 'test/model:free' },
          { systemPrompt: 'sys', userPrompt: 'user', maxOutputTokens: 50 },
        ),
        (error: unknown) => error instanceof AiProviderError && error.kind === 'malformed_response',
      );
    },
  );
  await withMockServer(
    (path, res) => {
      if (path === '/models')
        res.writeHead(200, { 'content-type': 'application/json' }).end(freeCatalog);
      else
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ ok: true }));
    },
    async () => {
      await assert.rejects(
        requestCompletion(
          { apiKey: 'k', model: 'test/model:free' },
          { systemPrompt: 'sys', userPrompt: 'user', maxOutputTokens: 50 },
        ),
        (error: unknown) => error instanceof AiProviderError && error.kind === 'malformed_response',
      );
    },
  );
});

test('requestCompletion: a slow server times out with a typed failure, not an indefinite hang', async () => {
  await withMockServer(
    (path, res) => {
      if (path === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(freeCatalog);
      }
      // /chat/completions: never responds within the test's patience.
    },
    async () => {
      await assert.rejects(
        requestCompletion(
          { apiKey: 'k', model: 'test/model:free' },
          { systemPrompt: 'sys', userPrompt: 'user', maxOutputTokens: 50 },
        ),
        (error: unknown) => error instanceof AiProviderError && error.kind === 'timeout',
      );
    },
  );
});

test('requestCompletion: model absent from or no longer free on the catalog is refused, never silently substituted', async () => {
  await withMockServer(
    (path, res) => {
      if (path === '/models')
        res.writeHead(200, { 'content-type': 'application/json' }).end(freeCatalog);
      else res.writeHead(200).end('{}');
    },
    async () => {
      await assert.rejects(
        requestCompletion(
          { apiKey: 'k', model: 'not-in-catalog/model:free' },
          { systemPrompt: 'sys', userPrompt: 'user', maxOutputTokens: 50 },
        ),
        (error: unknown) => error instanceof AiProviderError && error.kind === 'model_unavailable',
      );
    },
  );
  const noLongerFreeCatalog = JSON.stringify({
    data: [{ id: 'test/model:free', pricing: { prompt: '0.000002', completion: '0.000002' } }],
  });
  await withMockServer(
    (path, res) => {
      if (path === '/models')
        res.writeHead(200, { 'content-type': 'application/json' }).end(noLongerFreeCatalog);
      else res.writeHead(200).end('{}');
    },
    async () => {
      await assert.rejects(
        requestCompletion(
          { apiKey: 'k', model: 'test/model:free' },
          { systemPrompt: 'sys', userPrompt: 'user', maxOutputTokens: 50 },
        ),
        (error: unknown) =>
          error instanceof AiProviderError && error.kind === 'model_no_longer_free',
      );
    },
  );
});

test('requestCompletion: a catalog fetch failure fails safely too, not as an implicit pass', async () => {
  await withMockServer(
    (path, res) => {
      if (path === '/models') res.writeHead(500).end('server error');
      else res.writeHead(200).end('{}');
    },
    async () => {
      await assert.rejects(
        requestCompletion(
          { apiKey: 'k', model: 'test/model:free' },
          { systemPrompt: 'sys', userPrompt: 'user', maxOutputTokens: 50 },
        ),
        (error: unknown) => error instanceof AiProviderError && error.kind === 'server_error',
      );
    },
  );
});

test('the API key is never present in any log output across every failure mode', async () => {
  const captured: string[] = [];
  const { logger } = await import('./runtime.js');
  const originalWarn = logger.warn.bind(logger);
  logger.warn = (...args: unknown[]) => {
    captured.push(JSON.stringify(args));
    return originalWarn(...(args as [never]));
  };
  const secretApiKey = 'sk-or-v1-super-secret-value-that-must-never-be-logged';
  try {
    for (const status of [401, 402, 429, 500]) {
      await withMockServer(
        (path, res) => {
          if (path === '/models')
            res.writeHead(200, { 'content-type': 'application/json' }).end(freeCatalog);
          else res.writeHead(status).end('{}');
        },
        async () => {
          await assert.rejects(
            requestCompletion(
              { apiKey: secretApiKey, model: 'test/model:free' },
              { systemPrompt: 'sys', userPrompt: 'user', maxOutputTokens: 50 },
            ),
          );
        },
      );
    }
  } finally {
    logger.warn = originalWarn;
  }
  assert.ok(captured.length > 0, 'expected at least one warn call to have been captured');
  for (const entry of captured) assert.ok(!entry.includes(secretApiKey));
});

test('findElaborationTarget: finds a real check or question by id, returns null (not a throw) when the profile changed and the id is gone', () => {
  // Built through the real schema rather than as a literal. The literal that
  // used to be here was missing SEVEN required candidate/preferences/
  // application fields and assigned a string to `updatedAt: Date` - none of
  // which anything noticed, because v2 test files are not type-checked by
  // `npm run typecheck` (packages/core/tsconfig.json excludes `*.test.ts`).
  // A fixture that does not type-check against ProfileRecord is not evidence
  // about what prepareProfile does with a ProfileRecord.
  const record: ProfileRecord = {
    revision: 1,
    profile: writableProfileSchema.parse({
      candidate: {
        fullName: 'Test',
        email: 'test@example.test',
        location: 'Remote',
        phone: '',
        linkedin: '',
        github: '',
        portfolio: '',
      },
      preferences: { titles: ['Backend Engineer'], techStack: ['Node.js'] },
      application: { yearsOfExperience: 4 },
    }),
    updatedAt: new Date(),
    scheduledDiscoveryEnabled: false,
  };
  const report = prepareProfile(record);
  const target = findElaborationTarget(report, 'target');
  assert.ok(target);
  assert.equal(target.kind, 'check');
  assert.equal(findElaborationTarget(report, 'target-id-that-no-longer-exists'), null);
});

test('elaborate: a real profile carrying real PII reaches the provider as bounded report fields only', async () => {
  // AC7, and the version of this test that can actually FAIL. The previous one
  // hand-built a target literal containing no PII and then asserted the request
  // body contained no PII: it could only have failed if `elaborate` fabricated
  // and injected data it has no access to. The real question is whether the
  // path an owner actually takes - a saved profile, through prepareProfile and
  // findElaborationTarget, into elaborate - carries any of the profile it must
  // not. So the fixture below is a genuine ProfileRecord with genuine PII, run
  // through the real functions, and every check and question in the resulting
  // report is elaborated.
  //
  // The forbidden values are this fixture's OWN synthetic PII - a specific
  // email, a specific phone number, specific CTC figures - never generic
  // English words. The old list contained 'resume', which this product's own
  // checklist legitimately uses: the check titled 'Resume evidence and layout'
  // would have turned that assertion red for a non-defect, and the obvious
  // repair would have been to delete the word and weaken it further. A
  // specific value cannot be legitimately present, so it never has to be
  // softened.
  const pii = {
    fullName: 'Ada Q Lovelace',
    email: 'cs48-fixture-owner@example.test',
    phone: '+91 90000 11111',
    portfolio: 'https://portfolio.example.test/cs48-private-work-samples',
    linkedin: 'https://linkedin.example.test/in/cs48-fixture-owner',
    github: 'https://github.example.test/cs48-fixture-owner',
    currentCtc: '2450000',
    expectedCtc: '3175000',
  };
  const profile = writableProfileSchema.parse({
    candidate: {
      fullName: pii.fullName,
      email: pii.email,
      phone: pii.phone,
      location: 'Pune',
      linkedin: pii.linkedin,
      github: pii.github,
      portfolio: pii.portfolio,
    },
    preferences: {
      titles: ['Backend Engineer'],
      techStack: ['Node.js'],
      locations: [],
      remoteOnly: false,
      minSalary: null,
      employmentTypes: ['fulltime'],
      excludeKeywords: [],
      excludeCompanies: [],
    },
    application: {
      currentCtc: pii.currentCtc,
      expectedCtc: pii.expectedCtc,
      noticePeriodDays: 30,
      willingToRelocate: true,
      yearsOfExperience: 7,
    },
  });
  const record: ProfileRecord = {
    revision: 3,
    profile,
    updatedAt: new Date(),
    scheduledDiscoveryEnabled: false,
  };
  const report = prepareProfile(record);
  const ids = [...new Set([...report.checks, ...report.questions].map((entry) => entry.id))];
  assert.ok(ids.length >= 6, 'the fixture must produce a real report, not an empty one');

  let capturedBody = '';
  const bodies = new Map<string, string>();
  await withMockServer(
    (path, res) => {
      if (path === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(freeCatalog);
        return;
      }
      const chunks: Buffer[] = [];
      res.req.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.req.on('end', () => {
        capturedBody = Buffer.concat(chunks).toString('utf8');
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ choices: [{ message: { content: 'Coaching text.' } }] }));
      });
    },
    async () => {
      for (const id of ids) {
        const target = findElaborationTarget(report, id);
        assert.ok(target, `the report must expose ${id} through the real lookup`);
        capturedBody = '';
        const result = await elaborate({ apiKey: 'k', model: 'test/model:free' }, target);
        assert.equal(result.source, 'ai');
        assert.equal(result.model, 'test/model:free');
        // PROVE THE SURFACE LOADED before asserting anything is absent. An
        // empty body satisfies every "does not contain" assertion below.
        assert.ok(capturedBody.length > 0, `no request body was captured for ${id}`);
        const prompt = target.kind === 'check' ? target.title : target.question;
        assert.ok(
          capturedBody.includes(prompt.slice(0, 40)),
          `the request for ${id} must actually carry its own report text`,
        );
        bodies.set(id, capturedBody);
      }
    },
  );

  for (const [id, body] of bodies) {
    for (const [field, value] of Object.entries(pii)) {
      assert.equal(
        body.includes(value),
        false,
        `${field} from the saved profile reached the provider while elaborating ${id}`,
      );
    }
  }

  // The paired positives, on the same surface. Evidence the report DOES carry
  // is expected to travel - an assertion that nothing reached the provider
  // would otherwise pass against a request that sent nothing at all.
  assert.ok(bodies.get('target')!.includes('Backend Engineer'));
  assert.ok(bodies.get('skill-1')!.includes('Node.js'));
  // And the word the old assertion forbade is legitimately present here, which
  // is exactly why it must not be forbidden: this is coaching text about a
  // resume, not a leak of one.
  assert.ok(bodies.get('resume')!.includes('Resume evidence and layout'));
});

test('structural: no deterministic module in packages/core imports ai-provider or ai-assist - the deterministic engine cannot be reached from AI code', () => {
  // Independent Security review, CS-48 (finding H1): the original version of
  // this test resolved four `../` from this file and landed on the
  // unrelated top-level `packages/matching/src` directory
  // that has nothing to do with this package and would pass regardless of
  // what the deterministic pipeline does. ai-provider.ts and
  // ai-assist.ts live in *this* package (packages/core/src), alongside
  // dispatch.ts, jobs.ts, commands.ts, market.ts, database.ts etc. - there is
  // no package boundary between them, so the real check has to scan every
  // sibling source file in this directory, not a directory four levels up.
  const coreDir = fileURLToPath(new URL('.', import.meta.url));
  // index.ts is NO LONGER EXCLUDED (re-review finding 4). It used to be, on the
  // grounds that the barrel legitimately re-exported both modules - but that
  // exclusion was the hole: a deterministic sibling could have written
  // `import { elaborate } from './index.js'`, contained neither literal, and
  // passed. The barrel no longer re-exports them, so the route is gone rather
  // than merely watched, and the barrel is now scanned like any other file -
  // which is what stops someone re-adding the re-export.
  const excluded = new Set(['ai-provider.ts', 'ai-assist.ts']);
  const files = readdirSync(coreDir).filter(
    (name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && !excluded.has(name),
  );
  assert.ok(files.length > 10, 'expected to find packages/core deterministic source files');
  assert.ok(files.includes('index.ts'), 'the barrel must be scanned, not exempted');
  // MODULE SPECIFIERS, not raw text. This file's own package documents its
  // reasoning inline, and those comments necessarily quote the very identifiers
  // a substring scan looks for - index.ts now explains why it does NOT
  // re-export these, and a `content.includes('ai-provider')` check would fail
  // on the explanation. Matching `from '...'` and `import('...')` asserts the
  // property that actually matters: what the module is wired to.
  const specifiersOf = (content: string) => {
    const found: string[] = [];
    for (const match of content.matchAll(/\bfrom\s*'([^']+)'/g)) found.push(match[1]!);
    for (const match of content.matchAll(/\bimport\s*\(\s*'([^']+)'/g)) found.push(match[1]!);
    for (const match of content.matchAll(/\brequire\s*\(\s*'([^']+)'/g)) found.push(match[1]!);
    return found;
  };
  // Prove the extractor can see, before trusting what it does not see. A
  // specifier reader that silently returned nothing would make every assertion
  // below vacuous - the exact failure mode this project has been bitten by.
  const aiAssist = readFileSync(join(coreDir, 'ai-assist.ts'), 'utf8');
  assert.deepEqual(
    specifiersOf(aiAssist).filter((specifier) => specifier.includes('ai-provider')),
    ['./ai-provider.js', './ai-provider.js'],
    'the specifier extractor must actually find the imports it is meant to refuse elsewhere',
  );
  const forbidden = [
    './ai-provider.js',
    './ai-assist.js',
    '@careerscope/core/ai-provider',
    '@careerscope/core/ai-assist',
  ];
  for (const file of files) {
    const content = readFileSync(join(coreDir, file), 'utf8');
    for (const specifier of specifiersOf(content))
      assert.equal(
        forbidden.includes(specifier),
        false,
        `${file} must never import the AI modules; it imports ${specifier}`,
      );
    // And the barrel specifically must not put them back within reach.
    if (file === 'index.ts')
      assert.ok(
        !/export\s+\*\s+from\s+'\.\/ai-/.test(content),
        'index.ts must not re-export the AI modules; that is the hole this test exists to close',
      );
  }
});

test('structural: the AI modules are reachable ONLY by their explicit subpaths, which proves the scan above is not vacuous', () => {
  // The negative above is worth nothing unless the thing it forbids is
  // genuinely reachable another way - otherwise "no file imports ai-assist"
  // would pass against a package where ai-assist did not exist at all.
  const corePackage = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as { exports: Record<string, string> };
  assert.equal(corePackage.exports['./ai-provider'], './dist/ai-provider.js');
  assert.equal(corePackage.exports['./ai-assist'], './dist/ai-assist.js');
  const barrel = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');
  assert.ok(barrel.includes("export * from './market.js'"), 'the barrel must still export core');
  assert.ok(!/export\s+\*\s+from\s+'\.\/ai-/.test(barrel));
});
