import { execFileSync, spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const BACKLOG = '.ai/backlog.json';
const LOOP = '.ai/LOOP-STATE.json';
const MODE = '.ai/process-mode.json';
// process.env.TEMP is Windows-only; on Linux it is undefined and every backup
// path became the literal string "undefined/...".
const bBak = join(tmpdir(), 'careerscope-b.bak');
const lBak = join(tmpdir(), 'careerscope-l.bak');
const mBak = join(tmpdir(), 'careerscope-m.bak');
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
const today = new Date().toISOString().slice(0, 10);
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

// The daily ticket review must refuse a board it cannot trust, and must refuse
// to call a day reviewed when nothing records who decided what.
const reviewPath = join('.ai', 'tickets', `${new Date().toISOString().slice(0, 10)}.json`);
const rBak = join(tmpdir(), 'careerscope-r.bak');
const hadReview = existsSync(reviewPath);
if (hadReview) copyFileSync(reviewPath, rBak);
const ticket = (patch = {}) => ({
  id: 'T1',
  title: 'synthetic ticket',
  status: 'READY',
  priority: 'P2',
  updatedAt: new Date().toISOString().slice(0, 10),
  ownerAgent: 'Backend',
  ...patch,
});
const clearReview = () => rmSync(reviewPath, { force: true });

setBacklog([ticket()]);
clearReview();
expect('tickets: valid board accepted', run('scripts/agile.mjs', ['tickets']), 0);
setBacklog([ticket({ status: 'NEARLY_DONE' })]);
clearReview();
expect('tickets: unknown status refused', run('scripts/agile.mjs', ['tickets']), 1);
setBacklog([ticket({ updatedAt: undefined })]);
clearReview();
expect('tickets: undated ticket refused', run('scripts/agile.mjs', ['tickets']), 1);
setBacklog([ticket({ status: 'QA', ownerAgent: undefined })]);
clearReview();
expect('tickets: unowned active ticket refused', run('scripts/agile.mjs', ['tickets']), 1);
setBacklog([ticket(), ticket()]);
clearReview();
expect('tickets: duplicate id refused', run('scripts/agile.mjs', ['tickets']), 1);
writeFileSync(BACKLOG, '{ not json');
clearReview();
expect('tickets: unreadable backlog refused', run('scripts/agile.mjs', ['tickets']), 1);

setBacklog([ticket()]);
clearReview();
expect('tickets: unreviewed day refused', run('scripts/agile.mjs', ['tickets', '--verify']), 1);
mkdirSync(join('.ai', 'tickets'), { recursive: true });
const review = (reviewed) =>
  writeFileSync(
    reviewPath,
    `${JSON.stringify({ date: today, participants: ['Project Manager'], reviewed }, null, 2)}\n`,
  );
review([{ id: 'T1' }]);
expect(
  'tickets: ticket listed without an outcome refused',
  run('scripts/agile.mjs', ['tickets', '--verify']),
  1,
);
review([{ id: 'T1', outcome: 'kept in READY; no evidence changed' }]);
expect(
  'tickets: fully recorded review accepted',
  run('scripts/agile.mjs', ['tickets', '--verify']),
  0,
);
clearReview();
if (hadReview) {
  copyFileSync(rBak, reviewPath);
  unlinkSync(rBak);
}

// Promotion and release closing must both refuse a claim they cannot evidence.
const FINDINGS = '.ai/findings.json';
const fBak = join(tmpdir(), 'careerscope-f.bak');
copyFileSync(FINDINGS, fBak);
const findings = JSON.parse(readFileSync(FINDINGS, 'utf8'));
const setFindings = (list) =>
  writeFileSync(FINDINGS, `${JSON.stringify({ ...findings, findings: list }, null, 2)}\n`);
const qaTicket = (patch = {}) =>
  ticket({
    status: 'QA',
    acceptanceCriteria: ['a criterion that can fail'],
    evidence: ['command output'],
    completedSteps: ['QA'],
    ...patch,
  });

setFindings([]);
setBacklog([qaTicket({ completedSteps: [] })]);
expect('promote: QA step not completed refused', run('scripts/agile.mjs', ['promote']), 1);
setBacklog([qaTicket({ evidence: [] })]);
expect('promote: ticket without evidence refused', run('scripts/agile.mjs', ['promote']), 1);
setBacklog([qaTicket({ acceptanceCriteria: [] })]);
expect('promote: ticket without criteria refused', run('scripts/agile.mjs', ['promote']), 1);
setFindings([{ id: 'X1', severity: 'P1', status: 'OPEN' }]);
setBacklog([qaTicket()]);
expect('promote: open P1 finding refused', run('scripts/agile.mjs', ['promote']), 1);
setFindings([{ id: 'X1', severity: 'P1', status: 'FIXED' }]);
expect('promote: evidenced ticket promoted', run('scripts/agile.mjs', ['promote']), 0);
expect(
  'promote: ticket actually moved to UAT',
  JSON.parse(readFileSync(BACKLOG, 'utf8')).items[0].status,
  'UAT',
);

// The live site is the only acceptable proof that something was deployed. The
// fixture runs in its own process: execFileSync below blocks this one's event
// loop, so a server hosted here would never accept the connection.
const readyFile = join(tmpdir(), 'careerscope-health.port');
rmSync(readyFile, { force: true });
const health = spawn(
  process.execPath,
  [
    '-e',
    `const {createServer}=require('node:http');const {writeFileSync}=require('node:fs');` +
      `const s=createServer((q,r)=>{r.writeHead(200,{'content-type':'application/json'});` +
      `r.end(JSON.stringify({status:'ok',version:'9.9.9'}))});` +
      `s.listen(0,'127.0.0.1',()=>writeFileSync(${JSON.stringify(readyFile)},String(s.address().port)))`,
  ],
  { stdio: 'ignore' },
);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let port = null;
for (let attempt = 0; attempt < 50 && port === null; attempt += 1) {
  if (existsSync(readyFile)) port = readFileSync(readyFile, 'utf8').trim();
  else sleep(100);
}
if (port === null) throw new Error('health fixture did not start');
const healthUrl = `http://127.0.0.1:${port}/api/health`;
const close = (args) => run('scripts/agile.mjs', ['released', ...args]);
expect('released: missing version refused', close(['--commit', 'abcdef1']), 1);
expect('released: missing commit refused', close(['--version', '9.9.9']), 1);
expect(
  'released: unreachable site refused',
  close(['--version', '9.9.9', '--commit', 'abcdef1', '--health-url', 'http://127.0.0.1:1/api']),
  1,
);
expect(
  'released: live version mismatch refused',
  close(['--version', '9.9.8', '--commit', 'abcdef1', '--health-url', healthUrl]),
  1,
);
expect(
  'released: ticket still not released after refusal',
  JSON.parse(readFileSync(BACKLOG, 'utf8')).items[0].status,
  'UAT',
);
expect(
  'released: matching live version closes the ticket',
  close(['--version', '9.9.9', '--commit', 'abcdef1', '--health-url', healthUrl]),
  0,
);
expect(
  'released: ticket recorded as RELEASED',
  JSON.parse(readFileSync(BACKLOG, 'utf8')).items[0].status,
  'RELEASED',
);
health.kill();
rmSync(readyFile, { force: true });
copyFileSync(fBak, FINDINGS);
unlinkSync(fBak);

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
