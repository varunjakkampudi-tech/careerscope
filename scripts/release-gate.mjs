#!/usr/bin/env node
/**
 * Release gate. Decides whether the current release may deploy.
 *
 * It reads canonical state and **refuses by default**. Every gate must be
 * explicitly satisfied with evidence; an absent field is a refusal, not a pass.
 * That direction matters — a gate that defaults to allowing is a gate that
 * approves anything it failed to parse, which is how this project has already
 * produced four checks that passed while unable to detect failure.
 *
 * Never edit state to satisfy this. Never deploy around it.
 *
 *   node scripts/release-gate.mjs          evaluate the current release
 *   node scripts/release-gate.mjs --json   machine-readable
 *
 * Exit 0 = may deploy. Exit 1 = BLOCKED.
 */
import { existsSync, readFileSync } from 'node:fs';
import process from 'node:process';

const read = (path, fallback = null) => {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8').replace(/\r\n/g, '\n'));
  } catch (error) {
    return { parseError: error.message };
  }
};

const plan = read('.ai/release-plan.json');
const findings = read('.ai/findings.json', { findings: [] });

const results = [];
const gate = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail });

// Unreadable state is a refusal, not an absence. Collapsing "cannot parse" into
// "empty" made this gate MORE permissive when its inputs were corrupt: a
// malformed findings.json yielded zero findings, so "no open P0 or P1" passed
// and a release that was BLOCKED reported READY TO DEPLOY.
for (const [path, state] of [
  ['.ai/release-plan.json', plan],
  ['.ai/findings.json', findings],
]) {
  if (state?.parseError) {
    process.stdout.write(`BLOCKED  unreadable state — ${path}: ${state.parseError}\n`);
    process.exit(1);
  }
}
if (!Array.isArray(findings.findings)) {
  process.stdout.write(
    'BLOCKED  .ai/findings.json has no findings array; cannot prove there are no blockers.\n',
  );
  process.exit(1);
}

if (!plan) {
  process.stdout.write('BLOCKED  .ai/release-plan.json is missing.\n');
  process.exit(1);
}

const release = plan.currentRelease;

if (!release) {
  process.stdout.write('BLOCKED  No current release. Nothing to deploy.\n');
  process.exit(1);
}

// Severity that blocks regardless of anything else being green.
const open = (findings.findings ?? []).filter((f) => f.status !== 'FIXED' && f.status !== 'CLOSED');
const blockers = open.filter((f) => f.severity === 'P0' || f.severity === 'P1');

gate('release has an id and version', Boolean(release.releaseId && release.version));
gate('scope frozen', release.scopeFrozen === true);
gate(
  'every selected feature complete',
  Array.isArray(release.features) &&
    release.features.length > 0 &&
    release.features.every((f) => f.status === 'complete'),
  Array.isArray(release.features)
    ? `${release.features.filter((f) => f.status === 'complete').length}/${release.features.length}`
    : 'features missing',
);
gate('required tests pass', release.ci?.tests === 'pass');
gate('build passes', release.ci?.build === 'pass');
gate('CI green', release.ci?.status === 'green');
gate('security review passed', release.acceptance?.security === 'pass');
gate('browser validation passed', release.acceptance?.browser === 'pass');
gate('migrations verified against a populated database', release.acceptance?.migrations === 'pass');
gate('deployment artifact created', Boolean(release.deployment?.artifact));
gate('commit SHA recorded', /^[0-9a-f]{7,40}$/.test(String(release.deployment?.commit ?? '')));
gate('rollback identified', Boolean(release.rollback?.plan));
gate(`no open P0 or P1 findings`, blockers.length === 0, blockers.map((f) => f.id).join(', '));

// Changes that are never automatic, however green the rest is.
const needsHuman = [
  'destructiveMigration',
  'dataDeletion',
  'credentialChange',
  'securityBoundaryChange',
  'authChange',
  'encryptionChange',
  'firewallChange',
  'proxyTopologyChange',
  'billingChange',
  'providerAccountChange',
].filter((key) => release.safety?.[key] === true);
gate(
  'no change requiring explicit human approval',
  needsHuman.length === 0 || release.safety?.humanApproval === true,
  needsHuman.length ? `requires approval for: ${needsHuman.join(', ')}` : '',
);

const failed = results.filter((r) => !r.ok);

if (process.argv.includes('--json')) {
  process.stdout.write(
    `${JSON.stringify({ releaseId: release.releaseId, blocked: failed.length > 0, gates: results }, null, 2)}\n`,
  );
} else {
  process.stdout.write(`\n  RELEASE GATE  ${release.releaseId ?? 'unknown'}\n\n`);
  for (const r of results) {
    process.stdout.write(
      `  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  ${r.detail}` : ''}\n`,
    );
  }
  process.stdout.write(
    failed.length === 0
      ? '\n  READY TO DEPLOY\n\n'
      : `\n  BLOCKED — ${failed.length} gate(s) not satisfied. Move the scope to the next cycle.\n\n`,
  );
}

process.exit(failed.length === 0 ? 0 : 1);
