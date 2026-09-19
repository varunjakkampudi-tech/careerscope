import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import process from 'node:process';

const BACKLOG = '.ai/backlog.json';
const LOOP = '.ai/LOOP-STATE.json';
const MODE = '.ai/process-mode.json';
const bBak = `${process.env.TEMP}/b.bak`;
const lBak = `${process.env.TEMP}/l.bak`;
const mBak = `${process.env.TEMP}/m.bak`;
copyFileSync(BACKLOG, bBak);
copyFileSync(LOOP, lBak);
copyFileSync(MODE, mBak);

const mode = JSON.parse(readFileSync(MODE, 'utf8'));
const setMode = (patch) =>
  writeFileSync(MODE, `${JSON.stringify({ ...mode, ...patch }, null, 2)}\n`);

// The WIP limit must hold on its own terms. Running these while the process is
// paused would short-circuit the command and prove nothing.
setMode({ mode: 'ACTIVE' });

const run = (script, args = []) => {
  try {
    execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    return 0;
  } catch (error) {
    return error.status ?? 1;
  }
};

const backlog = JSON.parse(readFileSync(BACKLOG, 'utf8'));
const item = (id, status) => ({ id, title: `synthetic ${id}`, status, size: 'S', priority: 'P2' });
const setBacklog = (items) =>
  writeFileSync(BACKLOG, `${JSON.stringify({ ...backlog, items }, null, 2)}\n`);

const results = [];
const expect = (name, actual, wanted) => {
  const ok = actual === wanted;
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(52)} expected ${wanted}, got ${actual}`);
};

// WIP limit
setBacklog([]);
expect('WIP 0 of 2 allowed', run('scripts/agile.mjs', ['feature']), 0);
setBacklog([item('F1', 'IN_PROGRESS'), item('F2', 'QA')]);
expect('WIP 2 of 2 allowed', run('scripts/agile.mjs', ['feature']), 0);
setBacklog([item('F1', 'IN_PROGRESS'), item('F2', 'QA'), item('F3', 'SECURITY')]);
expect('WIP 3 of 2 refused', run('scripts/agile.mjs', ['feature']), 1);

// Agent state validation: an agent busy with no active agent is a lie.
const loop = JSON.parse(readFileSync(LOOP, 'utf8'));
writeFileSync(
  LOOP,
  `${JSON.stringify({ ...loop, activeAgent: null, agents: { ...loop.agents, 'careerscope-qa-agent': 'RUNNING' } }, null, 2)}\n`,
);
expect('agent busy with no active agent refused', run('scripts/check-agents.mjs'), 1);
writeFileSync(LOOP, `${JSON.stringify(loop, null, 2)}\n`);
expect('restored agent state accepted', run('scripts/check-agents.mjs'), 0);

// Scheduler must stay off until its prerequisites are proven.
const plan = JSON.parse(readFileSync('.ai/release-plan.json', 'utf8'));
writeFileSync(
  '.ai/release-plan.json',
  `${JSON.stringify({ ...plan, schedulerEnabled: true }, null, 2)}\n`,
);
expect('scheduler enabled refused', run('scripts/check-agents.mjs'), 1);
writeFileSync('.ai/release-plan.json', `${JSON.stringify(plan, null, 2)}\n`);
expect('scheduler disabled accepted', run('scripts/check-agents.mjs'), 0);

// Pausing must actually stop the ceremony, and must never stop a safety control.
setBacklog([item('F1', 'IN_PROGRESS'), item('F2', 'QA'), item('F3', 'SECURITY')]);
setMode({ mode: 'PAUSED', paused: ['agile:feature'] });
expect('paused: feature does not start work', run('scripts/agile.mjs', ['feature']), 0);
expect('paused: status still reports', run('scripts/agile.mjs', ['status']), 0);
setMode({ mode: 'ACTIVE' });
expect('resumed: WIP limit enforced again', run('scripts/agile.mjs', ['feature']), 1);
setMode({ mode: 'PAUSED', paused: ['agile:feature'] });
// The release gate is not ceremony; pausing the process must not make it pass.
expect('paused: release gate still refuses', run('scripts/agile.mjs', ['release']), 1);
copyFileSync(mBak, MODE);

copyFileSync(bBak, BACKLOG);
copyFileSync(lBak, LOOP);
unlinkSync(bBak);
unlinkSync(lBak);
unlinkSync(mBak);

const failures = results.filter((r) => !r).length;
console.log(
  `\n${failures === 0 ? 'ALL AGILE GATES PROVEN' : `${failures} gate(s) did not behave`}`,
);
process.exit(failures === 0 ? 0 : 1);
