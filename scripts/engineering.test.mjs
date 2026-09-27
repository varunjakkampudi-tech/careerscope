import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { URL } from 'node:url';
import { Buffer } from 'node:buffer';
import test from 'node:test';
import { RISK_ROLES, transitionTask, validateBaseline } from './engineering-contract.mjs';
import {
  AREAS,
  contentDigest,
  loadEngineering,
  normalizeClaim,
  readRevision,
  validateEngineering,
} from './engineering.mjs';

const { structuredClone } = globalThis;
const revision = 'a'.repeat(40);
const time = '2026-01-01T00:00:00.000Z';
const owner = 'careerscope-senior-engineer';
const reviewer = 'careerscope-independent-reviewer';
const agents = new Set([owner, reviewer]);
const check = { id: 'acceptance', description: 'Synthetic acceptance assertion' };

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'careerscope-engineering-'));
  try {
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, '.ai'));
    mkdirSync(join(root, '.github/agents'), { recursive: true });
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git/HEAD'), `${revision}\n`);
    for (const agent of agents)
      writeFileSync(join(root, `.github/agents/${agent}.agent.md`), 'synthetic');
    writeFileSync(join(root, 'src/code.mjs'), 'export const value = 1;\n');
    const task = {
      id: 'setup',
      owner,
      files: ['src'],
      dependencies: [],
      attempts: 1,
      attemptLimit: 3,
      status: 'COMPLETE',
      acceptanceCriteria: [check],
      evidence: [],
      review: null,
      createdAt: time,
      updatedAt: time,
      blockedReason: null,
    };
    const state = {
      schemaVersion: 1,
      objective: 'Synthetic objective',
      status: 'COMPLETE',
      revision,
      createdAt: time,
      updatedAt: time,
      blockedReason: null,
      tasks: [task],
    };
    const gates = {
      schemaVersion: 1,
      areas: Object.fromEntries(
        AREAS.map((area) => [
          area,
          {
            status: 'VERIFIED',
            applicability: { applicable: true, reason: null },
            responsibleAgent: owner,
            evidence: [],
            checks: [check],
            knownIssues: [],
            lastReviewed: null,
            reviewer: null,
          },
        ]),
      ),
    };
    const seal = () => {
      const digest = contentDigest(state, gates, root);
      const evidence = [
        {
          id: 'acceptance-run',
          check: 'acceptance',
          kind: 'acceptance',
          command: 'synthetic assertion',
          result: 'PASS',
          revision,
          digest,
          recordedAt: time,
        },
        {
          id: 'regression-run',
          check: 'regression',
          kind: 'regression',
          command: 'synthetic regression',
          result: 'PASS',
          revision,
          digest,
          recordedAt: time,
        },
      ];
      const review = { agent: reviewer, verdict: 'APPROVED', revision, digest, reviewedAt: time };
      for (const entry of state.tasks) {
        entry.evidence = structuredClone(evidence);
        entry.review = { ...review };
      }
      for (const gate of Object.values(gates.areas)) {
        gate.evidence = structuredClone(evidence);
        gate.reviewer = { ...review };
        gate.lastReviewed = time;
      }
    };
    seal();
    const validate = () => validateEngineering(state, gates, { root, agents, revision });
    const save = () => {
      writeFileSync(join(root, '.ai/engineering.json'), JSON.stringify(state));
      writeFileSync(join(root, 'quality-gates.json'), JSON.stringify(gates));
    };
    run({ root, state, gates, task, seal, validate, save });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function expandedFixture(run, risk = 'R0') {
  fixture((context) => {
    const { root, state, gates, task } = context;
    mkdirSync(join(root, 'docs/ai'), { recursive: true });
    writeFileSync(
      join(root, 'docs/ai/baseline.json'),
      JSON.stringify({ schemaVersion: 1, failures: [] }),
    );
    state.schemaVersion = 2;
    task.files = ['src/code.mjs'];
    task.attempts = 0;
    task.contract = {
      risk,
      baseline: 'docs/ai/baseline.json',
      forbiddenPaths: ['scripts'],
      changedPaths: ['src/code.mjs'],
      history: [
        'CREATED',
        'READY',
        'ASSIGNED',
        'IN_PROGRESS',
        'IMPLEMENTED',
        'VERIFYING',
        'REVIEW',
        'PASSED',
        'COMPLETE',
      ].map((status) => ({ status, at: time, actor: owner, findings: [] })),
      checks: RISK_ROLES[risk].map((role) => ({
        role,
        checkId: 'acceptance',
        applicable: true,
        reason: null,
      })),
      reviews: RISK_ROLES[risk].map((role) => ({
        role,
        agent: reviewer,
        verdict: 'APPROVED',
        findings: [],
        revision,
        digest: '0'.repeat(64),
        reviewedAt: time,
      })),
      approvalRequired: risk === 'R4',
      humanApproval: ['R4', 'R5'].includes(risk)
        ? { actor: 'human-operator', approvedAt: time, reason: 'Synthetic approval' }
        : null,
      failures: [],
    };
    const seal = () => {
      context.seal();
      const digest = contentDigest(state, gates, root);
      for (const entry of state.tasks) {
        entry.review.findings = [];
        for (const review of entry.contract.reviews) review.digest = digest;
      }
    };
    const setStatus = (status) => {
      const index = task.contract.history.findIndex((event) => event.status === status);
      task.contract.history = task.contract.history.slice(0, index + 1);
      task.status = status;
      state.status = 'IN_PROGRESS';
      for (const gate of Object.values(gates.areas)) gate.status = 'NOT_STARTED';
    };
    seal();
    run({ ...context, seal, setStatus });
  });
}

for (const risk of Object.keys(RISK_ROLES))
  test(`v2 ${risk} complete requires each independent role/check`, () =>
    expandedFixture(({ task, validate, seal }) => {
      assert.equal(validate().complete, true, JSON.stringify(validate()));
      task.contract.checks.pop();
      assert.equal(validate().valid, false);
      task.contract.checks.push({
        role: RISK_ROLES[risk].at(-1),
        checkId: 'acceptance',
        applicable: true,
        reason: null,
      });
      seal();
      assert.equal(validate().complete, true);
      task.contract.reviews[0].agent = owner;
      assert.equal(validate().valid, false);
    }, risk));

const expandedMutations = [
  [
    'illegal shortcut',
    ({ task }) => {
      task.contract.history.splice(4, 4);
    },
  ],
  [
    'status disagrees with replay',
    ({ task }) => {
      task.status = 'REVIEW';
    },
  ],
  [
    'malformed history',
    ({ task }) => {
      task.contract.history = {};
    },
  ],
  [
    'unknown history actor',
    ({ task }) => {
      task.contract.history[0].actor = 'unknown';
    },
  ],
  [
    'missing baseline',
    ({ root }) => {
      rmSync(join(root, 'docs/ai/baseline.json'));
    },
  ],
  [
    'malformed baseline',
    ({ root }) => {
      writeFileSync(join(root, 'docs/ai/baseline.json'), '{');
    },
  ],
  [
    'empty baseline object',
    ({ root }) => {
      writeFileSync(join(root, 'docs/ai/baseline.json'), '{}');
    },
  ],
  [
    'null baseline',
    ({ root }) => {
      writeFileSync(join(root, 'docs/ai/baseline.json'), 'null');
    },
  ],
  [
    'unsafe baseline',
    ({ task }) => {
      task.contract.baseline = '../baseline.json';
    },
  ],
  [
    'out-of-scope changes',
    ({ task }) => {
      task.contract.changedPaths.push('src/other.mjs');
    },
  ],
  [
    'forbidden overlap',
    ({ task }) => {
      task.contract.forbiddenPaths = ['SRC'];
    },
  ],
  [
    'missing existing file',
    ({ task }) => {
      task.files = ['src/new.mjs'];
    },
  ],
  [
    'directory is not allowed file',
    ({ task }) => {
      task.files = ['src'];
    },
  ],
  [
    'rejected review',
    ({ task }) => {
      task.contract.reviews[0].verdict = 'REJECTED';
      task.contract.reviews[0].findings = ['Fix'];
    },
  ],
  [
    'rejection without findings',
    ({ task }) => {
      task.contract.reviews[0].verdict = 'REJECTED';
    },
  ],
  [
    'final rejection without findings',
    ({ task }) => {
      task.review.verdict = 'CHANGES_REQUESTED';
    },
  ],
  [
    'final rejection prevents progress',
    ({ task }) => {
      task.review.verdict = 'CHANGES_REQUESTED';
      task.review.findings = ['Fix'];
      task.status = 'REVIEW';
      task.contract.history.splice(-2);
    },
  ],
  [
    'stale role review',
    ({ task }) => {
      task.contract.reviews[0].digest = 'b'.repeat(64);
    },
  ],
  [
    'counter reset',
    ({ task }) => {
      task.attempts = 1;
    },
  ],
  [
    'digest binds changed paths',
    ({ task }) => {
      task.contract.changedPaths = [];
    },
  ],
  [
    'digest binds history',
    ({ task }) => {
      task.contract.history[0].findings = ['Changed input'];
    },
  ],
  [
    'digest binds baseline bytes',
    ({ root }) => {
      writeFileSync(
        join(root, 'docs/ai/baseline.json'),
        JSON.stringify({
          schemaVersion: 1,
          failures: [{ checkId: 'acceptance', signature: 'new' }],
        }),
      );
    },
  ],
];
for (const [name, mutate] of expandedMutations)
  test(`v2 rejects ${name}`, () =>
    expandedFixture((context) => {
      assert.equal(context.validate().complete, true);
      mutate(context);
      assert.equal(context.validate().valid, false, JSON.stringify(context.validate()));
    }));

for (const status of [
  'ASSIGNED',
  'IN_PROGRESS',
  'WAITING',
  'IMPLEMENTED',
  'VERIFYING',
  'REVIEW',
  'PASSED',
])
  test(`v2 claims conflict at ${status}`, () =>
    expandedFixture(({ state, task, setStatus, seal, validate }) => {
      setStatus(status === 'WAITING' ? 'IN_PROGRESS' : status);
      if (status === 'WAITING') {
        task.status = status;
        task.contract.history.push({ status, at: time, actor: owner, findings: [] });
      }
      state.tasks.push({ ...structuredClone(task), id: 'overlap' });
      seal();
      assert.match(validate().errors[0], /overlap/);
    }));

test('v2 ready excludes dependencies, active overlap and R5 even when approved', () =>
  expandedFixture(({ task, state, setStatus, seal, validate }) => {
    setStatus('READY');
    seal();
    assert.deepEqual(validate().ready, ['setup']);
    const other = structuredClone(task);
    other.id = 'other';
    other.status = 'ASSIGNED';
    other.contract.history.push({ status: 'ASSIGNED', at: time, actor: owner, findings: [] });
    state.tasks.push(other);
    seal();
    assert.deepEqual(validate().ready, []);
    task.dependencies = ['other'];
    seal();
    assert.deepEqual(validate().ready, []);
  }));

test('v2 R5 requires blocked record until approval, never automatically ready', () =>
  expandedFixture(({ task, setStatus, seal, validate }) => {
    setStatus('READY');
    seal();
    assert.deepEqual(validate().ready, []);
    task.contract.humanApproval = null;
    assert.equal(validate().valid, false);
    task.contract.history = [
      task.contract.history[0],
      { status: 'BLOCKED', at: time, actor: owner, findings: ['Human approval required'] },
    ];
    task.status = 'BLOCKED';
    task.blockedReason = 'Human approval required';
    seal();
    assert.equal(validate().valid, true, JSON.stringify(validate()));
  }, 'R5'));

function failureRecord(index = 0) {
  return {
    id: `failure-${index}`,
    checkId: 'acceptance',
    command: 'synthetic assertion',
    at: time,
    exitCode: 1,
    result: 'FAIL',
    signature: 'assertion-failure',
    classification: 'REGRESSION_INTRODUCED',
    introducedBy: 'setup',
    phase: index === 0 ? 'INITIAL' : 'REMEDIATION',
    attempt: index,
    strategy: `strategy-${index}`,
    nextAction: 'Review mechanism',
    resolvedBy: null,
  };
}

test('v2 evidence and review survive forward completion without future records', () =>
  expandedFixture(({ task, state, gates, root, setStatus, validate }) => {
    setStatus('VERIFYING');
    task.contract.history.forEach((event, index) => {
      event.at = new Date(Date.parse(time) + index * 1000).toISOString();
    });
    const later = (seconds) => new Date(Date.parse(time) + seconds * 1000).toISOString();
    task.updatedAt = state.updatedAt = later(6);
    task.review = null;
    task.contract.reviews = [];
    const digest = contentDigest(state, gates, root);
    task.evidence.forEach((item) => {
      item.digest = digest;
      item.recordedAt = later(6);
    });
    assert.equal(validate().valid, true, JSON.stringify(validate()));
    const advance = (status, seconds) => {
      Object.assign(
        task,
        transitionTask(task, {
          status,
          at: later(seconds),
          actor: owner,
          findings: [],
        }),
      );
      state.updatedAt = task.updatedAt;
      assert.equal(contentDigest(state, gates, root), digest);
    };
    advance('REVIEW', 7);
    task.updatedAt = state.updatedAt = later(9);
    task.contract.reviews = task.contract.checks.map(({ role }) => ({
      role,
      agent: reviewer,
      verdict: 'APPROVED',
      findings: [],
      revision,
      digest,
      reviewedAt: later(8),
    }));
    task.review = {
      agent: reviewer,
      verdict: 'APPROVED',
      findings: [],
      revision,
      digest,
      reviewedAt: later(9),
    };
    advance('PASSED', 10);
    assert.equal(validate().valid, true, JSON.stringify(validate()));
    advance('COMPLETE', 11);
    assert.equal(validate().valid, true, JSON.stringify(validate()));
    task.review.reviewedAt = later(6);
    assert.equal(validate().valid, false);
    task.review.reviewedAt = later(10.5);
    assert.equal(validate().valid, false);
    task.review.reviewedAt = later(9);
    assert.equal(validate().valid, true, JSON.stringify(validate()));
    for (const gate of Object.values(gates.areas)) {
      gate.status = 'VERIFIED';
      gate.evidence = structuredClone(task.evidence);
      gate.reviewer = {
        agent: reviewer,
        verdict: 'APPROVED',
        revision,
        digest,
        reviewedAt: later(9),
      };
      gate.lastReviewed = later(9);
    }
    state.status = 'COMPLETE';
    assert.equal(validate().complete, true, JSON.stringify(validate()));
    task.contract.history.at(-1).status = 'CREATED';
    assert.equal(validate().valid, false);
    task.contract.history.at(-1).status = 'COMPLETE';
    assert.equal(validate().complete, true, JSON.stringify(validate()));
  }));

test('v2 linking a successful rerun does not invalidate its digest', () =>
  expandedFixture(({ task, state, gates, root, setStatus, validate }) => {
    setStatus('VERIFYING');
    task.review = null;
    task.contract.reviews = [];
    task.contract.failures = [failureRecord()];
    const digest = contentDigest(state, gates, root);
    task.evidence.forEach((item) => {
      item.digest = digest;
    });
    assert.equal(validate().valid, true, JSON.stringify(validate()));
    task.contract.failures[0].resolvedBy = 'acceptance-run';
    assert.equal(contentDigest(state, gates, root), digest);
    assert.equal(validate().valid, true, JSON.stringify(validate()));
    task.contract.failures[0].resolvedBy = 'missing';
    assert.equal(validate().valid, false);
    task.contract.failures[0].resolvedBy = {};
    assert.equal(validate().valid, false);
    task.contract.failures[0].resolvedBy = 'acceptance-run';
    assert.equal(validate().valid, true, JSON.stringify(validate()));
    task.contract.failures[0].signature = 'changed failure';
    assert.notEqual(contentDigest(state, gates, root), digest);
  }));

test('v2 retains semantic and signal failures even with zero or absent exit codes', () =>
  expandedFixture(({ task, setStatus, validate }) => {
    setStatus('VERIFYING');
    task.review = null;
    task.contract.reviews = [];
    task.contract.failures = [failureRecord()];
    for (const exitCode of [0, null, 1]) {
      task.contract.failures[0].exitCode = exitCode;
      assert.equal(validate().valid, true, JSON.stringify(validate()));
    }
    for (const exitCode of [-1, '0', {}, 0.5]) {
      task.contract.failures[0].exitCode = exitCode;
      assert.equal(validate().valid, false);
    }
    task.contract.failures[0].exitCode = 0;
    task.contract.failures[0].result = 'PASS';
    assert.equal(validate().valid, false);
    task.contract.failures[0].result = 'FAIL';
    assert.equal(validate().valid, true, JSON.stringify(validate()));
  }));

test('v2 retains failed evidence, requires linked current successful rerun, rejects broken link', () =>
  expandedFixture(({ task, seal, validate }) => {
    task.contract.failures = [{ ...failureRecord(), resolvedBy: 'acceptance-run' }];
    seal();
    task.evidence.unshift({
      ...task.evidence[0],
      id: 'failure-0',
      result: 'FAIL',
      digest: 'b'.repeat(64),
    });
    assert.equal(validate().complete, true, JSON.stringify(validate()));
    task.contract.failures[0].resolvedBy = 'missing';
    assert.equal(validate().valid, false);
    task.contract.failures[0].resolvedBy = 'acceptance-run';
    assert.equal(validate().complete, true);
  }));

test('v2 third remediation failure requires escalation and preserves counters', () =>
  expandedFixture(({ task, setStatus, seal, validate }) => {
    setStatus('IN_PROGRESS');
    task.contract.failures = [0, 1, 2, 3].map(failureRecord);
    task.attempts = 3;
    seal();
    assert.match(validate().errors[0], /escalation/);
    for (const status of ['FAILED', 'ESCALATED'])
      task.contract.history.push({
        status,
        at: time,
        actor: owner,
        findings: ['Retries exhausted'],
      });
    task.status = 'ESCALATED';
    seal();
    assert.equal(validate().valid, true, JSON.stringify(validate()));
    task.contract.failures[2].strategy = task.contract.failures[1].strategy;
    assert.match(validate().errors[0], /repeated/);
    task.contract.failures[2].strategy = 'new-strategy';
    task.contract.failures[3].attempt = 1;
    assert.match(validate().errors[0], /reset or gap/);
  }));

test('v2 baseline-existing classification must match baseline signature and check ID', () =>
  expandedFixture(({ task, root, setStatus, seal, validate }) => {
    setStatus('IN_PROGRESS');
    task.contract.failures = [{ ...failureRecord(), classification: 'BASELINE_EXISTING' }];
    seal();
    assert.match(validate().errors[0], /classification/);
    writeFileSync(
      join(root, 'docs/ai/baseline.json'),
      JSON.stringify({
        schemaVersion: 1,
        failures: [{ checkId: 'acceptance', signature: 'assertion-failure' }],
      }),
    );
    seal();
    assert.equal(validate().valid, true, JSON.stringify(validate()));
  }));

for (const status of ['PASSED', 'COMPLETE'])
  test(`v2 rejects final approval after ${status}`, () =>
    expandedFixture(({ task, state, setStatus, validate }) => {
      if (status === 'PASSED') setStatus(status);
      assert.equal(validate().valid, true, JSON.stringify(validate()));
      task.updatedAt = state.updatedAt = '2026-01-01T00:00:01.000Z';
      task.review.reviewedAt = task.updatedAt;
      assert.equal(validate().valid, false, JSON.stringify(validate()));
      task.review.reviewedAt = time;
      assert.equal(validate().valid, true, JSON.stringify(validate()));
    }));

test('v2 independent review timestamps do not self-invalidate evidence', () =>
  expandedFixture(({ task, state, root, gates, validate }) => {
    const digest = contentDigest(state, gates, root);
    const later = '2026-01-01T00:00:01.000Z';
    task.contract.history.find(({ status }) => status === 'PASSED').at = '2026-01-01T00:00:02.000Z';
    task.contract.history.find(({ status }) => status === 'COMPLETE').at =
      '2026-01-01T00:00:03.000Z';
    state.updatedAt = task.updatedAt = task.contract.history.at(-1).at;
    task.contract.reviews[0].reviewedAt = later;
    task.review.reviewedAt = later;
    assert.equal(contentDigest(state, gates, root), digest);
    assert.equal(validate().complete, true, JSON.stringify(validate()));
  }));

test('v2 R4 explicit approval cannot be absent or arrive after assignment', () =>
  expandedFixture(({ task, validate }) => {
    task.contract.humanApproval = null;
    assert.match(validate().errors[0], /approval/);
    task.contract.humanApproval = {
      actor: 'operator',
      approvedAt: '2026-01-01T00:00:01.000Z',
      reason: 'Too late',
    };
    assert.equal(validate().valid, false);
  }, 'R4'));

test('v2 policy shapes reject combined keys rather than flattening field names', () =>
  expandedFixture(({ task, validate }) => {
    task.contract['approvalRequired baseline'] = false;
    delete task.contract.approvalRequired;
    delete task.contract.baseline;
    assert.equal(validate().valid, false);
  }));

test('valid complete fixture passes; content mutation fails; restoration passes', () =>
  fixture(({ root, validate }) => {
    assert.equal(validate().complete, true);
    const path = join(root, 'src/code.mjs');
    const original = readFileSync(path);
    writeFileSync(path, 'dirty change with unchanged HEAD');
    assert.equal(validate().valid, false);
    writeFileSync(path, original);
    assert.equal(validate().complete, true);
  }));

const mutations = [
  [
    'missing state field',
    ({ state }) => {
      delete state.tasks;
    },
  ],
  [
    'unknown state field',
    ({ state }) => {
      state.percentage = 100;
    },
  ],
  [
    'empty tasks',
    ({ state }) => {
      state.tasks = [];
    },
  ],
  [
    'missing area',
    ({ gates }) => {
      delete gates.areas.seo;
    },
  ],
  [
    'unknown area',
    ({ gates }) => {
      gates.areas.extra = gates.areas.seo;
    },
  ],
  [
    'malformed areas',
    ({ gates }) => {
      gates.areas = [];
    },
  ],
  [
    'invalid status',
    ({ task }) => {
      task.status = 'done';
    },
  ],
  [
    'unknown owner',
    ({ task }) => {
      task.owner = 'invented';
    },
  ],
  [
    'unknown reviewer',
    ({ task }) => {
      task.review.agent = 'invented';
    },
  ],
  [
    'self review',
    ({ task }) => {
      task.review.agent = owner;
    },
  ],
  [
    'missing review',
    ({ task }) => {
      task.review = null;
    },
  ],
  [
    'changes requested',
    ({ task }) => {
      task.review.verdict = 'CHANGES_REQUESTED';
    },
  ],
  [
    'duplicate IDs',
    ({ state, task }) => {
      state.tasks.push(structuredClone(task));
    },
  ],
  [
    'missing dependency',
    ({ task }) => {
      task.dependencies = ['missing'];
    },
  ],
  [
    'self cycle',
    ({ task }) => {
      task.dependencies = ['setup'];
    },
  ],
  [
    'multi task cycle',
    ({ state, task }) => {
      task.dependencies = ['other'];
      state.tasks.push({ ...structuredClone(task), id: 'other', dependencies: ['setup'] });
    },
  ],
  [
    'malformed timestamp',
    ({ task }) => {
      task.updatedAt = 'yesterday';
    },
  ],
  [
    'invalid calendar date',
    ({ task }) => {
      task.updatedAt = '2026-02-30T00:00:00.000Z';
    },
  ],
  [
    'future timestamp',
    ({ state }) => {
      state.updatedAt = '2999-01-01T00:00:00.000Z';
    },
  ],
  [
    'timestamp ordering',
    ({ task }) => {
      task.createdAt = '2026-01-02T00:00:00.000Z';
    },
  ],
  [
    'evidence after update',
    ({ task }) => {
      task.evidence[0].recordedAt = '2026-01-02T00:00:00.000Z';
    },
  ],
  [
    'empty evidence',
    ({ task }) => {
      task.evidence = [];
    },
  ],
  [
    'failed evidence',
    ({ task }) => {
      task.evidence[0].result = 'FAIL';
    },
  ],
  [
    'missing regression',
    ({ task }) => {
      task.evidence.pop();
    },
  ],
  [
    'missing acceptance',
    ({ task }) => {
      task.evidence.shift();
    },
  ],
  [
    'unknown acceptance',
    ({ task }) => {
      task.evidence[0].check = 'unknown';
    },
  ],
  [
    'duplicate evidence',
    ({ task }) => {
      task.evidence.push(task.evidence[0]);
    },
  ],
  [
    'stale revision',
    ({ task }) => {
      task.evidence[0].revision = 'b'.repeat(40);
    },
  ],
  [
    'stale objective revision',
    ({ state }) => {
      state.revision = 'b'.repeat(40);
    },
  ],
  [
    'stale digest',
    ({ task }) => {
      task.evidence[0].digest = 'b'.repeat(64);
    },
  ],
  [
    'stale review',
    ({ task }) => {
      task.review.digest = 'b'.repeat(64);
    },
  ],
  [
    'negative attempts',
    ({ task }) => {
      task.attempts = -1;
    },
  ],
  [
    'fractional limit',
    ({ task }) => {
      task.attemptLimit = 1.5;
    },
  ],
  [
    'attempt overflow',
    ({ task }) => {
      task.attempts = 4;
    },
  ],
  [
    'zero completed attempts',
    ({ task }) => {
      task.attempts = 0;
    },
  ],
  [
    'empty acceptance',
    ({ task }) => {
      task.acceptanceCriteria = [];
    },
  ],
  [
    'changed acceptance',
    ({ task }) => {
      task.acceptanceCriteria[0] = { ...check, description: 'Weakened condition' };
    },
  ],
  [
    'changed objective',
    ({ state }) => {
      state.objective = 'Different objective';
    },
  ],
  [
    'missing exclusion reason',
    ({ gates }) => {
      gates.areas.seo.applicability = { applicable: false, reason: null };
    },
  ],
  [
    'gate self review',
    ({ gates }) => {
      gates.areas.seo.reviewer.agent = owner;
    },
  ],
  [
    'gate unknown owner',
    ({ gates }) => {
      gates.areas.seo.responsibleAgent = 'unknown';
    },
  ],
  [
    'gate failed evidence',
    ({ gates }) => {
      gates.areas.seo.evidence[0].result = 'FAIL';
    },
  ],
  [
    'gate unresolved issue',
    ({ gates, seal }) => {
      gates.areas.seo.knownIssues = ['Still broken'];
      seal();
    },
  ],
  [
    'gate mismatched review date',
    ({ gates }) => {
      gates.areas.seo.lastReviewed = null;
    },
  ],
  [
    'gate incomplete',
    ({ gates }) => {
      gates.areas.seo.status = 'NOT_STARTED';
    },
  ],
  [
    'BLOCKED without reason',
    ({ state }) => {
      state.status = 'BLOCKED';
    },
  ],
];
for (const [name, mutate] of mutations)
  test(`rejects ${name}`, () =>
    fixture((context) => {
      assert.equal(context.validate().complete, true);
      mutate(context);
      const result = context.validate();
      assert.equal(result.valid, false, JSON.stringify(result));
      if (name === 'gate unresolved issue')
        assert.deepEqual(result.errors, ['seo: unresolved known issues']);
    }));

for (const path of [
  '../outside',
  '/absolute',
  'C:\\outside',
  '\\\\server\\share',
  'src/../outside',
  'src\\..\\outside',
  'src/file:stream',
  'src/con.txt',
  'src/trailing.',
  'src/trailing ',
  'src//file',
  '.',
  '.env',
  'data/resumes',
]) {
  test(`rejects unsafe path ${JSON.stringify(path)}`, () =>
    assert.throws(() => normalizeClaim(path)));
}

test('BLOCKED is valid, incomplete and never eligible, even at attempt limit', () =>
  fixture(({ state, task, validate }) => {
    state.status = task.status = 'BLOCKED';
    state.blockedReason = task.blockedReason = 'Awaiting independent review';
    task.attempts = task.attemptLimit;
    const result = validate();
    assert.equal(result.valid, true);
    assert.equal(result.complete, false);
    assert.deepEqual(result.ready, []);
  }));

for (const otherFile of ['src/code.mjs', 'SRC\\CODE.MJS', 'src', 'SRC/'])
  test(`active overlap ${otherFile}`, () =>
    fixture(({ state, task, seal, validate }) => {
      state.status = task.status = 'IN_PROGRESS';
      state.tasks.push({ ...structuredClone(task), id: 'other', files: [otherFile] });
      const result = validate();
      assert.equal(result.valid, false);
      assert.match(result.errors[0], /overlap/);
      state.tasks.pop();
      seal();
      assert.equal(validate().valid, true);
    }));

test('active exhausted attempts rejected, honest blocked replacement accepted', () =>
  fixture(({ state, task, validate }) => {
    state.status = task.status = 'IN_PROGRESS';
    task.attempts = task.attemptLimit;
    assert.match(validate().errors[0], /exhausted/);
    task.status = 'BLOCKED';
    task.blockedReason = 'Attempt limit reached';
    assert.equal(validate().valid, true);
  }));

test('dependency readiness and active claims filter eligible work without executing', () =>
  fixture(({ state, task, seal, validate }) => {
    state.status = 'IN_PROGRESS';
    const next = {
      ...structuredClone(task),
      id: 'next',
      files: ['new.mjs'],
      dependencies: ['setup'],
      status: 'NOT_STARTED',
      attempts: 0,
      evidence: [],
      review: null,
    };
    state.tasks.push(next);
    seal();
    assert.deepEqual(validate().ready, ['next']);
    task.status = 'IN_PROGRESS';
    assert.deepEqual(validate().ready, []);
    next.status = 'IN_PROGRESS';
    next.attempts = 1;
    assert.match(validate().errors[0], /dependencies not COMPLETE/);
  }));

test('pending overlap waits but disjoint pending work remains eligible', () =>
  fixture(({ state, task, seal, validate }) => {
    state.status = task.status = 'IN_PROGRESS';
    state.tasks.push({
      ...structuredClone(task),
      id: 'overlap',
      files: ['src/code.mjs'],
      status: 'NOT_STARTED',
      attempts: 0,
    });
    state.tasks.push({
      ...structuredClone(task),
      id: 'disjoint',
      files: ['new.mjs'],
      status: 'NOT_STARTED',
      attempts: 0,
    });
    seal();
    assert.deepEqual(validate().ready, ['disjoint']);
  }));

test('directory additions, deletions and new planned files invalidate evidence', () =>
  fixture(({ root, state, task, seal, validate }) => {
    writeFileSync(join(root, 'src/new.mjs'), 'new');
    assert.equal(validate().valid, false);
    rmSync(join(root, 'src/new.mjs'));
    assert.equal(validate().complete, true);
    rmSync(join(root, 'src/code.mjs'));
    assert.equal(validate().valid, false);
    state.status = task.status = 'IN_PROGRESS';
    task.files = ['planned.mjs'];
    seal();
    const digest = validate().digest;
    writeFileSync(join(root, 'planned.mjs'), 'created');
    assert.notEqual(validate().digest, digest);
  }));

test('symlink or junction paths cannot escape scope', () =>
  fixture(({ root, task, validate }) => {
    mkdirSync(join(root, 'outside'));
    symlinkSync(
      join(root, 'outside'),
      join(root, 'src/link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    task.files = ['src/link/missing.mjs'];
    assert.match(validate().errors[0], /symbolic links/);
  }));

test('non-applicable gate needs independent current approval; reason alone is insufficient', () =>
  fixture(({ gates, seal, validate }) => {
    const gate = gates.areas.seo;
    gate.status = 'NOT_STARTED';
    gate.applicability = { applicable: false, reason: 'CLI has no indexable public surface' };
    seal();
    assert.equal(validate().complete, true);
    gate.reviewer = null;
    gate.lastReviewed = null;
    assert.equal(validate().valid, false);
  }));

test('missing and malformed records fail closed using isolated files', () =>
  fixture(({ root, save }) => {
    assert.throws(() => loadEngineering(root));
    save();
    assert.equal(loadEngineering(root).result.complete, true);
    for (const invalid of ['', '{', 'null', '[]', '{}']) {
      writeFileSync(join(root, '.ai/engineering.json'), invalid);
      try {
        assert.equal(loadEngineering(root).result.valid, false);
      } catch (error) {
        assert.ok(error instanceof SyntaxError);
      }
    }
    save();
    rmSync(join(root, 'quality-gates.json'));
    assert.throws(() => loadEngineering(root));
  }));

test('excluded gate cannot hide retained FAIL evidence by changing status or approval', () =>
  fixture(({ gates, seal, validate }) => {
    const gate = gates.areas.seo;
    gate.applicability = { applicable: false, reason: 'No public surface' };
    seal();
    for (const status of ['NOT_STARTED', 'VERIFIED', 'NOT_STARTED']) {
      gate.status = status;
      assert.equal(validate().complete, true);
      gate.evidence[0].result = 'FAIL';
      gate.reviewer = { ...gate.reviewer, verdict: 'APPROVED' };
      const result = validate();
      assert.equal(result.complete, false);
      assert.equal(result.valid, false);
      assert.match(result.errors[0], /seo: unresolved failed evidence/);
      gate.evidence[0].result = 'PASS';
      assert.equal(validate().complete, true);
    }
  }));

test('finished proof cannot certify a missing claimed file even after resealing', () =>
  fixture(({ root, task, seal, validate }) => {
    task.files = ['src/code.mjs'];
    seal();
    assert.equal(validate().complete, true);
    rmSync(join(root, 'src/code.mjs'));
    seal();
    for (const status of ['VERIFIED', 'COMPLETE']) {
      task.status = status;
      assert.deepEqual(validate().errors, ['setup: claimed file missing: src/code.mjs']);
    }
    writeFileSync(join(root, 'src/code.mjs'), 'export const value = 1;\n');
    seal();
    assert.equal(validate().complete, true);
  }));

test('agent IDs are case-insensitive without allowing self review', () =>
  fixture(({ task, gates, seal, validate }) => {
    task.owner = owner.toUpperCase();
    gates.areas.seo.responsibleAgent = owner.toUpperCase();
    seal();
    task.review.agent = reviewer.toUpperCase();
    gates.areas.seo.reviewer.agent = reviewer.toUpperCase();
    assert.equal(validate().complete, true);
    task.review.agent = owner;
    assert.deepEqual(validate().errors, ['setup: review must be independent']);
    task.review.agent = reviewer;
    gates.areas.seo.reviewer.agent = owner;
    assert.deepEqual(validate().errors, ['seo: review must be independent']);
    gates.areas.seo.reviewer.agent = reviewer;
    assert.equal(validate().complete, true);
  }));

for (const reference of ['refs/heads/feature+fix', 'refs/heads/\u65e5\u672c\u8a9e'])
  test(`Git legal ref ${reference} resolves loose and packed`, () =>
    fixture(({ root }) => {
      writeFileSync(join(root, '.git/HEAD'), `ref: ${reference}\n`);
      mkdirSync(join(root, '.git/refs/heads'), { recursive: true });
      writeFileSync(join(root, '.git', reference), revision);
      assert.equal(readRevision(root), revision);
      rmSync(join(root, '.git', reference));
      writeFileSync(join(root, '.git/packed-refs'), `${revision} ${reference}\n`);
      assert.equal(readRevision(root), revision);
    }));

for (const reference of [
  'refs/heads/../../outside',
  'refs/heads/..\\outside',
  'refs//heads/main',
  'refs/heads/./main',
  'refs/heads/.hidden',
  'refs/heads/main.lock',
  'refs/heads/main.lock/child',
  'refs/heads/main.',
  'refs/heads/main/',
  'refs/heads/has space',
  'refs/heads/main ',
  'refs/heads/main\t',
  'refs/heads/main\u007f',
  'refs/heads/main@{1}',
  'refs/heads/main~1',
  'refs/heads/main^',
  'refs/heads/main:stream',
  'refs/heads/main?',
  'refs/heads/main*',
  'refs/heads/main[',
  '/refs/heads/main',
])
  test(`Git rejects invalid ref ${JSON.stringify(reference)} before loose or packed lookup`, () =>
    fixture(({ root }) => {
      writeFileSync(join(root, '.git/HEAD'), `ref: ${reference}\n`);
      assert.throws(() => readRevision(root), /^Error: invalid Git HEAD$/);
      writeFileSync(join(root, '.git/packed-refs'), `${revision} ${reference}\n`);
      assert.throws(() => readRevision(root), /^Error: invalid Git HEAD$/);
    }));

test('Git loose ref cannot escape through a directory symlink or junction', () =>
  fixture(({ root }) => {
    mkdirSync(join(root, 'outside'));
    writeFileSync(join(root, 'outside/main'), revision);
    mkdirSync(join(root, '.git/refs'));
    symlinkSync(
      join(root, 'outside'),
      join(root, '.git/refs/heads'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    writeFileSync(join(root, '.git/HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(root, '.git/packed-refs'), `${revision} refs/heads/main\n`);
    assert.throws(() => readRevision(root), /Git reference escapes directory/);
  }));

test('Git detached HEAD, loose and packed refs work without subprocesses', () =>
  fixture(({ root }) => {
    assert.equal(readRevision(root), revision);
    writeFileSync(join(root, '.git/HEAD'), 'ref: refs/heads/main\n');
    mkdirSync(join(root, '.git/refs/heads'), { recursive: true });
    writeFileSync(join(root, '.git/refs/heads/main'), revision);
    assert.equal(readRevision(root), revision);
    rmSync(join(root, '.git/refs/heads/main'));
    writeFileSync(join(root, '.git/packed-refs'), `${revision} refs/heads/main\n`);
    assert.equal(readRevision(root), revision);
    writeFileSync(join(root, '.git/HEAD'), 'malformed');
    assert.throws(() => readRevision(root));
  }));

test('Git worktree pointer resolves common packed refs without subprocesses', () =>
  fixture(({ root }) => {
    rmSync(join(root, '.git'), { recursive: true });
    mkdirSync(join(root, 'git-common/worktrees/fixture'), { recursive: true });
    writeFileSync(join(root, '.git'), 'gitdir: git-common/worktrees/fixture\n');
    writeFileSync(join(root, 'git-common/worktrees/fixture/HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(root, 'git-common/worktrees/fixture/commondir'), '../..\n');
    writeFileSync(join(root, 'git-common/packed-refs'), `${revision} refs/heads/main\n`);
    assert.equal(readRevision(root), revision);
  }));

test('combined field names cannot masquerade as two required quality areas', () =>
  fixture(({ gates, validate }) => {
    gates.areas['architecture|backend'] = gates.areas.architecture;
    delete gates.areas.architecture;
    delete gates.areas.backend;
    assert.equal(validate().valid, false);
    assert.match(validate().errors[0], /areas: incorrect fields/);
  }));

test('scope byte limit fails closed before reading oversized content', () =>
  fixture(({ root, validate }) => {
    writeFileSync(join(root, 'src/large'), Buffer.alloc(16 * 1024 * 1024));
    assert.match(validate().errors[0], /16 MiB/);
  }));

test('scope entry limit rejects oversized directory claims', () =>
  fixture(({ root, validate }) => {
    for (let index = 0; index < 2000; index += 1)
      writeFileSync(join(root, `src/file-${index}`), '');
    assert.match(validate().errors[0], /2000 entries/);
  }));

test('report updates do not self-invalidate the digest of owned state files', () =>
  fixture(({ state, task, seal, save, validate }) => {
    task.files.push('.ai/engineering.json', 'quality-gates.json');
    save();
    seal();
    save();
    assert.equal(validate().complete, true);
    const digest = validate().digest;
    state.status = 'VERIFIED';
    save();
    assert.equal(validate().digest, digest);
    assert.equal(validate().complete, false);
  }));

test('malformed gate JSON and missing agent registry fail closed', () =>
  fixture(({ root, save }) => {
    for (const invalid of ['', '{', 'null', '[]', '{}']) {
      save();
      writeFileSync(join(root, 'quality-gates.json'), invalid);
      try {
        assert.equal(loadEngineering(root).result.valid, false);
      } catch (error) {
        assert.ok(error instanceof SyntaxError);
      }
    }
    save();
    rmSync(join(root, '.github/agents'), { recursive: true });
    assert.throws(() => loadEngineering(root));
  }));

test('a BLOCKED gate needs a known issue, but check does not equate it to readiness', () =>
  fixture(({ state, gates, validate }) => {
    state.status = 'IN_PROGRESS';
    for (const gate of Object.values(gates.areas)) gate.status = 'NOT_STARTED';
    state.tasks[0].status = 'IN_PROGRESS';
    gates.areas.security.status = 'BLOCKED';
    assert.equal(validate().valid, false);
    gates.areas.security.knownIssues = ['Independent security review unavailable'];
    assert.equal(validate().valid, true);
    assert.equal(validate().complete, false);
  }));

test('CLI help describes schema 1 and 2 readiness from current policy', () => {
  const child = spawnSync(process.execPath, ['scripts/engineering.mjs', 'help'], {
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /ready: schema v1 NOT_STARTED; schema v2 READY, excluding R5/);
  assert.match(child.stdout, /IN_PROGRESS objective at current revision/);
  assert.match(child.stdout, /attempts below attemptLimit, COMPLETE dependencies/);
  assert.match(child.stdout, /Readiness policy: validateEngineering in engineering\.mjs/);
  assert.match(child.stdout, /RISK_ROLES in engineering-contract\.mjs/);
});

test('CLI help requires a separate strict baseline without replacing historical records', () => {
  const child = spawnSync(process.execPath, ['scripts/engineering.mjs', 'help'], {
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /separately prepared strict baseline/);
  assert.match(child.stdout, /Do not mutate historical docs\/ai\/baseline\.json/);
  assert.doesNotMatch(child.stdout, /baseline: 'docs\/ai\/baseline\.json'/);
  const example = /^Strict baseline example: (.+)$/m.exec(child.stdout);
  assert.ok(example, 'Help must include a JSON baseline example');
  assert.deepEqual(validateBaseline(JSON.parse(example[1])), { schemaVersion: 1, failures: [] });
});

test('CLI check/ready/status/verify/help exit semantics are read-only', () =>
  fixture(({ root, state, task, save }) => {
    const moduleURL = new URL('./engineering.mjs', import.meta.url).href;
    const run = (command) =>
      spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { main } from ${JSON.stringify(moduleURL)}; process.exitCode = main([${JSON.stringify(command)}], ${JSON.stringify(root)});`,
        ],
        { encoding: 'utf8' },
      );
    save();
    for (const command of ['check', 'ready', 'status', 'verify', 'help'])
      assert.equal(run(command).status, 0, command);
    assert.equal(run('unknown').status, 1);
    state.status = task.status = 'BLOCKED';
    state.blockedReason = task.blockedReason = 'Review required';
    save();
    const before = readFileSync(join(root, '.ai/engineering.json'), 'utf8');
    assert.equal(run('check').status, 0);
    assert.equal(run('verify').status, 1);
    assert.deepEqual(JSON.parse(run('ready').stdout).ready, []);
    assert.equal(readFileSync(join(root, '.ai/engineering.json'), 'utf8'), before);
    writeFileSync(join(root, 'quality-gates.json'), '{');
    assert.equal(run('check').status, 1);
  }));
