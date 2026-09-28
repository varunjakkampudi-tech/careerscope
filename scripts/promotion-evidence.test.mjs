// Locks in what the promotion check must and must not do.
//
// The fixtures are synthetic but modelled directly on real board cases, and the
// pairing is the point. A check with only positive fixtures can demonstrate
// that it fires; it cannot demonstrate that it discriminates. The CS-19/CS-51
// pair is the case that proves the difference: two tickets carrying the *same*
// disclosed residual in nearly identical words, whose correct outcomes are
// opposite, because their acceptance criteria assert different things.
//
// Synthetic rather than read from .ai/backlog.json on purpose: that file is
// written by other sessions during a run, and a test that breaks when somebody
// edits a ticket is a test that gets deleted. The real five were verified
// against live data separately and the output recorded; this suite protects the
// logic those runs exercised.

import assert from 'node:assert/strict';
import test from 'node:test';
import { assess, parseLimitations } from './check-promotion-evidence.mjs';

const LIMITATIONS = `# Known Limitations

## Restarting the proxy alone is an outage

**Status: DEFERRED — INTENTIONAL** (mitigated, not eliminated)

Body.

---

## Screen reader not validated

**Status: OPEN — HUMAN VALIDATION**

None of that is a screen reader.

---

## No transactional email

**Status: OPEN — EXTERNAL**

Body.

---

## Job identity disambiguation only fires when one source proves multiplicity

**Status: DEFERRED — INTENTIONAL** (CS-28)

Body.

---

## Two rate limiters are global rather than per-client

**Status: NOT IMPLEMENTED**

Body.
`;

const context = { limitations: parseLimitations(LIMITATIONS) };
const shapes = (findings) => new Set(findings.map((finding) => finding.shape));
const blocking = (findings) => findings.filter((finding) => finding.severity === 'blocking');

test('parseLimitations refuses a register it cannot really have read', () => {
  assert.throws(() => parseLimitations('# Known Limitations\n\nnothing here'), /could not look/i);
  // And it must not quietly treat a deliberate deferral as an open failure.
  const proxy = context.limitations.find((s) => /Restarting the proxy/.test(s.heading));
  assert.equal(proxy.open, false);
  assert.equal(proxy.deferred, true);
  const reader = context.limitations.find((s) => /Screen reader/.test(s.heading));
  assert.equal(reader.open, true);
});

test('a clean ticket produces no findings', () => {
  const findings = assess(
    {
      id: 'T-clean',
      acceptanceCriteria: ['The list renders saved leads', 'A reload preserves the selection'],
      evidence: ['Browser assertions cover both, shown failing before passing'],
      completedSteps: [],
    },
    context,
  );
  assert.deepEqual(findings, []);
});

test('a ticket with no acceptance criteria at all is blocking', () => {
  const findings = assess({ id: 'T-bare', acceptanceCriteria: [], evidence: ['done'] }, context);
  assert.equal(blocking(findings).length, 1);
  assert.ok(shapes(findings).has('no-acceptance-criteria'));
});

test('a criterion demanding verification of an OPEN limitation is blocking (CS-14 shape)', () => {
  const findings = assess(
    {
      id: 'T-14',
      acceptanceCriteria: ['Keyboard and screen-reader operable, verified not assumed'],
      evidence: ['check-ui.mjs asserts no overflow at 320px'],
    },
    context,
  );
  assert.ok(shapes(findings).has('contradicted-by-limitations-register'));
  assert.equal(blocking(findings).length, 1);
});

test('the hyphen spelling does not hide the contradiction', () => {
  // "screen-reader" in the criterion, "Screen reader" in the register. This
  // silently never fired once, which is the whole failure mode.
  const hyphenated = assess(
    { id: 'T-h', acceptanceCriteria: ['screen-reader operable, not assumed'], evidence: [] },
    context,
  );
  const spaced = assess(
    { id: 'T-s', acceptanceCriteria: ['screen reader operable, not assumed'], evidence: [] },
    context,
  );
  assert.equal(shapes(hyphenated).has('contradicted-by-limitations-register'), true);
  assert.equal(shapes(spaced).has('contradicted-by-limitations-register'), true);
});

test('a DEFERRED limitation is advisory, never blocking (CS-33 false positive)', () => {
  const findings = assess(
    {
      id: 'T-33',
      acceptanceCriteria: ['Inventory owner/run/job identity, verified not assumed'],
      evidence: [],
    },
    context,
  );
  assert.equal(blocking(findings).length, 0);
});

test('"validated" as an adjective does not trigger the register cross-reference', () => {
  // CS-33's real AC1 says "a bounded validated read contract". An earlier
  // version treated that as a demand for verification and produced a false
  // BLOCKING on the first live run.
  const findings = assess(
    {
      id: 'T-adj',
      acceptanceCriteria: ['Define a bounded validated read contract for job identity facts'],
      evidence: [],
    },
    context,
  );
  assert.equal(shapes(findings).has('contradicted-by-limitations-register'), false);
});

test('a criterion naming CI with no CI run recorded is blocking (CS-2 shape)', () => {
  const withoutCi = assess(
    {
      id: 'T-2',
      acceptanceCriteria: ['check-ui.mjs green on all three engines in CI'],
      evidence: ['4 consecutive clean runs in a local Linux Playwright container'],
    },
    context,
  );
  assert.ok(shapes(withoutCi).has('ci-claimed-but-not-recorded'));

  const withCi = assess(
    {
      id: 'T-2b',
      acceptanceCriteria: ['check-ui.mjs green on all three engines in CI'],
      evidence: ['https://github.com/o/r/actions/runs/123456 green on all three engines'],
    },
    context,
  );
  assert.equal(shapes(withCi).has('ci-claimed-but-not-recorded'), false);
});

test('owner confirmation cannot be supplied by an agent (CS-50 shape)', () => {
  const substituted = assess(
    {
      id: 'T-50',
      acceptanceCriteria: ['An explicit, owner-confirmed product decision on scope'],
      evidence: ['Decision made with ChatGPT as the owner-directed review loop'],
    },
    context,
  );
  const finding = blocking(substituted).find(
    (entry) => entry.shape === 'owner-confirmation-substituted',
  );
  assert.ok(finding, 'the substitution must be blocking');
  assert.match(finding.detail, /ChatGPT/);

  const genuine = assess(
    {
      id: 'T-50b',
      acceptanceCriteria: ['An explicit, owner-confirmed product decision on scope'],
      evidence: ['2026-09-20: the owner confirmed the ATS timeline is out of scope'],
    },
    context,
  );
  assert.equal(shapes(genuine).has('owner-confirmation-substituted'), false);
});

test('a real-system demonstration cannot be satisfied by unit tests (CS-7 shape)', () => {
  const findings = assess(
    {
      id: 'T-7',
      acceptanceCriteria: [
        'Proven by pushing a commit with a deliberately failing check and observing deploy refuse',
      ],
      evidence: ['Gate logic: 22 checks pass, 5 mutations each detected, restored clean'],
    },
    context,
  );
  assert.ok(shapes(findings).has('real-system-demonstration-missing'));
  assert.equal(blocking(findings).length, 1);
});

// THE DISCRIMINATION TEST. Identical residual text, opposite correct outcomes.
test('the same residual blocks one criterion and not another (CS-19 vs CS-51)', () => {
  const residual =
    'NEEDS A BACKEND TICKET: SaveJob does not hydrate already-saved state on mount, so an ' +
    'already-saved job still renders as "Save Job". AC4 is unmet in the code.';

  // CS-19's AC4 puts the residual inside its own scope.
  const inScope = assess(
    {
      id: 'T-19',
      acceptanceCriteria: ['A duplicate posting already saved is recognised, not saved twice'],
      evidence: [residual],
    },
    context,
  );

  // CS-51's AC1 asks that identifiers which EXIST at a call site arrive. In the
  // mount-hydration case no identifier exists to discard, so the same sentence
  // is out of scope. Same text, different criterion, different verdict.
  const outOfScope = assess(
    {
      id: 'T-51',
      acceptanceCriteria: [
        'Every identifier that exists at a call site reaches its destination: SaveJob onOpen, initialId on /saved',
      ],
      evidence: [
        'NEEDS A BACKEND TICKET: add savedLeadId to search-job results or GET /api/leads?jobId=.',
      ],
    },
    context,
  );

  assert.equal(blocking(inScope).length, 1, 'CS-19 shape: the residual names an AC and blocks');
  assert.equal(
    blocking(outOfScope).length,
    0,
    'CS-51 shape: the same class of residual must NOT block — it is out of that criterion scope',
  );
  // It is still worth a human glance, which is what advisory is for.
  assert.equal(outOfScope.length, 1);
  assert.equal(outOfScope[0].severity, 'advisory');
});

test('a residual that names no acceptance criterion still blocks (CS-17 shape)', () => {
  // The tier used to depend on the text spelling "AC<n>". CS-17's real
  // disclosure — the most serious of the four founding cases — names no
  // criterion at all, and graded advisory, so it could not fail the gate.
  const findings = assess(
    {
      id: 'T-17',
      acceptanceCriteria: [
        'Save, dismiss and apply actions available without returning to the list',
      ],
      evidence: [
        'Recorded as an open product question (needs a schema decision), not silently built as a no-op button.',
      ],
    },
    context,
  );
  assert.equal(
    blocking(findings).length,
    1,
    'a precise disclosure must block whether or not it cites an AC',
  );
  assert.ok(shapes(findings).has('self-disclosed-residual'));
});

test('a blocking phrase attributed to a separate new ticket is advisory (CS-22 shape)', () => {
  const findings = assess(
    {
      id: 'T-22',
      acceptanceCriteria: ['The workspace renders saved leads'],
      evidence: [
        'See .ai/findings.json, and the new CS-46 ticket (the one genuine open product question this surfaced) for the full record',
      ],
    },
    context,
  );
  assert.equal(
    blocking(findings).length,
    0,
    'a disclosure about another ticket is not this ticket failing',
  );
  assert.equal(findings[0].severity, 'advisory');
});

test('prose mentioning a CI run is not a CI result (CS-2 shape)', () => {
  // The inverted-conclusion case, and the worst defect this check has had: the
  // marker accepted the letters "CI run", and CS-2's evidence contains
  // "...every CI run that exists predates it. AC3 IS NOT MERELY UNPROVEN, IT IS
  // UNPROVABLE". A sentence saying the criterion is unprovable satisfied the
  // test for it being proven, and suppressed the blocking finding.
  const prose = assess(
    {
      id: 'T-2',
      acceptanceCriteria: ['check-ui.mjs green on all three engines in CI'],
      evidence: [
        'LeadTable.tsx is UNCOMMITTED, so every CI run that exists predates it. AC3 IS NOT MERELY UNPROVEN, IT IS UNPROVABLE.',
      ],
    },
    context,
  );
  assert.ok(
    shapes(prose).has('ci-claimed-but-not-recorded'),
    'a sentence about CI must not stand in for a CI result',
  );

  // Only a locator a real run produces counts.
  for (const locator of [
    'https://github.com/o/r/actions/runs/1234567 green on all three engines',
    'workflow run id: 1234567 green on all three engines',
  ]) {
    const recorded = assess(
      {
        id: 'T-2b',
        acceptanceCriteria: ['check-ui.mjs green on all three engines in CI'],
        evidence: [locator],
      },
      context,
    );
    assert.equal(
      shapes(recorded).has('ci-claimed-but-not-recorded'),
      false,
      `a run locator must satisfy the criterion: ${locator}`,
    );
  }
});

test('a real-system demonstration is matched by the demand, not by an enumerated verb (CS-3, CS-24)', () => {
  // The rule was a verb list — pushing|deploying|observing deploy|... — and it
  // caught 1 of the 6 tickets its own comment cited. CS-3 and CS-24 both begin
  // "Proven by" and were missed because *killing* and *stopping* were not on
  // the list. These are their real criteria.
  const cases = [
    ['CS-3 AC2', 'Proven by killing Caddy and observing the result'],
    [
      'CS-24 AC3',
      'Proven by stopping a container and observing the alert, not by reading the config',
    ],
    [
      'CS-24 AC1',
      'Stopping the workers container surfaces to the owner within 15 minutes without opening the app',
    ],
    [
      'CS-25 AC2',
      'The restore is exercised, not documented — a dump nobody has restored is a guess',
    ],
    ['CS-26 AC1', 'With no user interaction for 48 hours, sighting counts increase'],
    [
      'CS-30 AC2',
      'After authorized configuration, verify intended SSH access and public HTTP/HTTPS while unwanted inbound ports remain blocked',
    ],
    [
      'CS-7 AC3',
      'Proven by pushing a commit with a deliberately failing check and observing deploy refuse',
    ],
  ];
  for (const [label, criterion] of cases) {
    const findings = assess(
      { id: label, acceptanceCriteria: [criterion], evidence: ['Implemented; unit tests pass'] },
      context,
    );
    assert.ok(
      shapes(findings).has('real-system-demonstration-missing'),
      `${label} demands a demonstration on a running system and must be caught: ${criterion}`,
    );
  }
});

test('an in-repository demonstration is not a real-system one (live false positives)', () => {
  // Each of these produced a false BLOCKING on a live UAT ticket. A gate with
  // false positives gets disabled within a day, and then it protects nothing.
  const cases = [
    [
      'CS-51 AC4',
      'Browser assertions cover each instance and are demonstrated failing before passing',
    ],
    ['CS-23 AC3', 'Proven by pointing a provider at a fixture whose shape no longer matches'],
    [
      'CS-34 AC2',
      'Verify with synthetic configuration that DATABASE_URL and other API-only credentials are absent from the web runtime',
    ],
    ['CS-49 AC5', 'Verified in all three browser engines at 320, 768 and 1440 widths'],
    ['CS-18 AC1', 'Per-dimension contributions shown, including the ones that scored badly'],
  ];
  for (const [label, criterion] of cases) {
    const findings = assess(
      { id: label, acceptanceCriteria: [criterion], evidence: ['Implemented; unit tests pass'] },
      context,
    );
    assert.equal(
      shapes(findings).has('real-system-demonstration-missing'),
      false,
      `${label} is satisfied inside the repository and must not be flagged: ${criterion}`,
    );
  }
});

test('explicit renderer and mutation proofs stay in-repository demonstrations', () => {
  const cases = [
    [
      'CS-67 AC2',
      'An unrecognised status or severity produces a visible error rather than a silent bucket, proven by feeding the renderer a bogus value',
    ],
    [
      'CS-78 AC5',
      'Proven by mutation: making the matcher read a fourth application field must fail v2 typecheck, and reverting it must make it pass again',
    ],
  ];
  for (const [label, criterion] of cases) {
    const findings = assess(
      {
        id: label,
        acceptanceCriteria: [criterion],
        evidence: ['2026-09-28: repository mutation and test proof recorded'],
      },
      context,
    );
    assert.equal(
      shapes(findings).has('real-system-demonstration-missing'),
      false,
      `${label} names an in-repository proof and must not require a host observation`,
    );
  }
});

test('a runbook that is ready is not a run (CS-30 shape)', () => {
  const criterion = 'Proven by killing Caddy and observing the result';
  const ready = assess(
    {
      id: 'T-runbook',
      acceptanceCriteria: [criterion],
      evidence: [
        'OPERATOR RUNBOOK READY 2026-09-25: .ai/OPERATOR-RUNBOOK-host-evidence.md contains the exact commands, expected output and pass criterion, including SSH access',
      ],
    },
    context,
  );
  assert.ok(
    shapes(ready).has('real-system-demonstration-missing'),
    'a dated document describing the commands is not a record of running them',
  );

  const performed = assess(
    {
      id: 'T-performed',
      acceptanceCriteria: [criterion],
      evidence: ['2026-09-25: the operator ran the kill and observed recovery within 40s'],
    },
    context,
  );
  assert.equal(shapes(performed).has('real-system-demonstration-missing'), false);
});

test('attribution to another ticket needs an identifier, not a common verb (P-1)', () => {
  const residual = 'Recorded as an open product question, needing a schema decision.';
  // "surfaced" used to downgrade anything within 160 characters of a residual.
  const bare = assess(
    {
      id: 'T-surfaced',
      acceptanceCriteria: ['The workspace renders saved leads'],
      evidence: [`${residual} It was surfaced while testing.`],
    },
    context,
  );
  assert.equal(blocking(bare).length, 1, 'a bare "surfaced" must not silence a residual');

  for (const attribution of [
    'the new CS-46 ticket covers it',
    'the open product question genuinely belongs to CS-46',
    'it needs its own ticket',
  ]) {
    const attributed = assess(
      {
        id: 'T-attributed',
        acceptanceCriteria: ['The workspace renders saved leads'],
        evidence: [`${residual} ${attribution}.`],
      },
      context,
    );
    assert.equal(blocking(attributed).length, 0, `should be advisory: ${attribution}`);
  }
});

test('"did not reproduce" blocks when it is about this ticket\'s own subject (P-4)', () => {
  const unrelated = assess(
    {
      id: 'T-flake',
      acceptanceCriteria: ['The list renders saved leads'],
      evidence: [
        'An unrelated failure was observed once and did not reproduce on immediate re-run',
      ],
    },
    context,
  );
  assert.equal(
    blocking(unrelated).length,
    0,
    'an unrelated flake is an observation, not a failure',
  );

  const ownSubject = assess(
    {
      id: 'T-never-existed',
      acceptanceCriteria: [
        'Reproduced in the Playwright Linux container, not guessed from Windows',
      ],
      evidence: ['the specific 768px offset this ticket names did not reproduce'],
    },
    context,
  );
  assert.equal(
    blocking(ownSubject).length >= 1,
    true,
    'a defect the ticket exists to fix, never confirmed to exist, is not an aside',
  );
});

test('nothing outside the claim fields is scanned', () => {
  // The repository documents its reasoning in prose that quotes the exact
  // phrases a grep would look for; two false findings have already come from
  // matching a comment. Title and userProblem are never claims about the work.
  const findings = assess(
    {
      id: 'T-prose',
      title: 'AC4 is unmet and the fix was disclosed not fixed',
      userProblem: 'Everything here remains BLOCKED and did not reproduce',
      summary: 'needs a backend ticket',
      acceptanceCriteria: ['The list renders'],
      evidence: ['Browser assertions cover it'],
    },
    context,
  );
  assert.deepEqual(findings, []);
});
