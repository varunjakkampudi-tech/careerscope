import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import process from 'node:process';

const BACKLOG = '.ai/backlog.json';
const LOOP = '.ai/LOOP-STATE.json';
const bBak = `${process.env.TEMP}/b.bak`;
const lBak = `${process.env.TEMP}/l.bak`;
copyFileSync(BACKLOG, bBak);
copyFileSync(LOOP, lBak);

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

copyFileSync(bBak, BACKLOG);
copyFileSync(lBak, LOOP);
unlinkSync(bBak);
unlinkSync(lBak);

const failures = results.filter((r) => !r).length;
console.log(
  `\n${failures === 0 ? 'ALL AGILE GATES PROVEN' : `${failures} gate(s) did not behave`}`,
);
process.exit(failures === 0 ? 0 : 1);
