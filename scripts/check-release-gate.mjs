import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import process from 'node:process';

const PLAN = '.ai/release-plan.json';
const FIND = '.ai/findings.json';
const backupPlan = `${process.env.TEMP}/plan.bak`;
const backupFind = `${process.env.TEMP}/find.bak`;
copyFileSync(PLAN, backupPlan);
copyFileSync(FIND, backupFind);

const node = process.execPath;
const run = () => {
  try {
    const out = execFileSync(node, ['scripts/release-gate.mjs'], { encoding: 'utf8' });
    return { code: 0, out };
  } catch (error) {
    return { code: error.status ?? 1, out: error.stdout ?? '' };
  }
};

const ready = {
  releaseId: 'SYNTH-001',
  version: '3.0.1',
  scopeFrozen: true,
  features: [{ id: 'F1', title: 'synthetic', status: 'complete' }],
  ci: { tests: 'pass', build: 'pass', status: 'green' },
  acceptance: { security: 'pass', browser: 'pass', migrations: 'pass' },
  deployment: { artifact: 'deploy.tgz', commit: 'a6294dd' },
  rollback: { plan: 'redeploy previous image' },
  safety: {},
};

const plan = JSON.parse(readFileSync(PLAN, 'utf8'));
const findings = JSON.parse(readFileSync(FIND, 'utf8'));

const set = (release, findingsOverride) => {
  writeFileSync(PLAN, `${JSON.stringify({ ...plan, currentRelease: release }, null, 2)}\n`);
  writeFileSync(
    FIND,
    `${JSON.stringify(findingsOverride ?? { ...findings, findings: [] }, null, 2)}\n`,
  );
};

const cases = [
  ['complete release', () => set(structuredClone(ready)), 0],
  ['scope not frozen', () => set({ ...structuredClone(ready), scopeFrozen: false }), 1],
  [
    'a feature incomplete',
    () =>
      set({
        ...structuredClone(ready),
        features: [{ id: 'F1', status: 'in_progress' }],
      }),
    1,
  ],
  ['CI not green', () => set({ ...structuredClone(ready), ci: { ...ready.ci, status: 'red' } }), 1],
  [
    'tests failing but CI claims green',
    () => set({ ...structuredClone(ready), ci: { ...ready.ci, tests: 'fail' } }),
    1,
  ],
  [
    'security not reviewed',
    () =>
      set({
        ...structuredClone(ready),
        acceptance: { ...ready.acceptance, security: 'pending' },
      }),
    1,
  ],
  [
    'migrations unverified',
    () =>
      set({
        ...structuredClone(ready),
        acceptance: { ...ready.acceptance, migrations: 'not-run' },
      }),
    1,
  ],
  ['no rollback plan', () => set({ ...structuredClone(ready), rollback: {} }), 1],
  [
    'commit SHA missing',
    () => set({ ...structuredClone(ready), deployment: { artifact: 'x' } }),
    1,
  ],
  [
    'open P1 finding',
    () =>
      set(structuredClone(ready), {
        ...findings,
        findings: [{ id: 'X1', severity: 'P1', status: 'OPEN' }],
      }),
    1,
  ],
  [
    'destructive migration without human approval',
    () => set({ ...structuredClone(ready), safety: { destructiveMigration: true } }),
    1,
  ],
  [
    'destructive migration WITH human approval',
    () =>
      set({
        ...structuredClone(ready),
        safety: { destructiveMigration: true, humanApproval: true },
      }),
    0,
  ],
];

let failures = 0;
for (const [name, mutate, expected] of cases) {
  mutate();
  const { code } = run();
  const ok = code === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(45)} expected exit ${expected}, got ${code}`);
}

copyFileSync(backupPlan, PLAN);
copyFileSync(backupFind, FIND);
unlinkSync(backupPlan);
unlinkSync(backupFind);
console.log(`\n${failures === 0 ? 'ALL GATES PROVEN' : `${failures} gate(s) did not behave`}`);
process.exit(failures === 0 ? 0 : 1);
