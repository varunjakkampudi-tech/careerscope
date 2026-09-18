#!/usr/bin/env node
/**
 * Product cycle entry points.
 *
 * These are the commands a scheduler would call. **They do not run agents.**
 * VS Code cannot invoke an agent from a shell, so each phase prepares and
 * validates the state an operator-driven agent session then works against, and
 * records the run. Pretending otherwise would be the fabricated automation this
 * system is meant to prevent.
 *
 *   npm run product:discover   prepare a discovery cycle
 *   npm run product:council    open a dated council record
 *   npm run product:plan       derive the next release from the backlog
 *   npm run product:release    evaluate the release gate
 *   npm run product:verify     check live evidence for the current release
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const AI = '.ai';
const read = (p, fallback = null) =>
  existsSync(p) ? JSON.parse(readFileSync(p, 'utf8').replace(/\r\n/g, '\n')) : fallback;
const write = (p, value) => writeFileSync(p, `${JSON.stringify(value, null, 2)}\n`);
const today = () => new Date().toISOString().slice(0, 10);

function commit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/** Every automated invocation is recorded, successful or not. */
function record(phase, result, errors = []) {
  const path = join(AI, 'runs.json');
  const log = read(path, { runs: [] });
  log.runs.push({
    runId: `${phase}-${Date.now()}`,
    phase,
    startedAt: started,
    completedAt: new Date().toISOString(),
    commit: commit(),
    result,
    errors,
  });
  log.runs = log.runs.slice(-200);
  log.updatedAt = new Date().toISOString();
  write(path, log);
}

const started = new Date().toISOString();
const phase = process.argv[2];

function discover() {
  const discovery = read(join(AI, 'product-discovery.json'));
  const backlog = read(join(AI, 'backlog.json'));
  const rejected = (backlog?.items ?? []).filter((i) => i.status === 'rejected');
  console.log(`\n  DISCOVERY  ${today()}\n`);
  console.log(`  Existing candidates   ${discovery?.candidates?.length ?? 0}`);
  console.log(`  Backlog items         ${backlog?.items?.length ?? 0}`);
  console.log(
    `  Previously rejected   ${rejected.length}  (do not re-propose without new evidence)`,
  );
  console.log('\n  Now run the Product Discovery agent. It is read-only; hand its');
  console.log('  candidates to the Orchestrator to write into product-discovery.json.\n');
  record('discover', 'prepared');
}

function council() {
  const dir = join(AI, 'daily-council');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${today()}.json`);
  if (existsSync(path)) {
    console.log(`\n  Council record already exists: ${path}\n`);
    record('council', 'already-exists');
    return;
  }
  write(path, {
    date: today(),
    commit: commit(),
    status: 'OPEN',
    timebox: {
      '0-5': 'What changed since yesterday?',
      '5-10': 'What user problems or opportunities were discovered?',
      '10-15': 'Technical feasibility and architecture',
      '15-20': 'UX, security and reliability',
      '20-25': 'Release scope selection',
      '25-30': 'Decision, ownership, acceptance criteria',
    },
    todaysChanges: [],
    topOpportunities: [],
    selectedFeatures: [],
    rejectedFeatures: [],
    deferredFeatures: [],
    risks: [],
    dependencies: [],
    releaseId: null,
    releaseDate: null,
    owners: [],
    acceptanceCriteria: [],
  });
  console.log(`\n  Council opened: ${path}`);
  console.log('  Every turn is bounded and the session ends with decisions, not discussion.\n');
  record('council', 'opened');
}

function plan() {
  const backlog = read(join(AI, 'backlog.json'), { items: [] });
  const ready = backlog.items.filter((i) => i.status === 'planned');
  const xl = ready.filter((i) => i.size === 'XL');
  console.log(`\n  RELEASE PLANNING  ${today()}\n`);
  console.log(`  Planned items   ${ready.length}`);
  if (xl.length) {
    console.log(`\n  ${xl.length} XL item(s) cannot enter a two-day release:`);
    for (const i of xl) console.log(`    ${i.id}  ${i.title}  -> split into vertical slices`);
  }
  if (ready.length > 3) {
    console.log('\n  More than 3 planned items. Prefer 1-3 coherent features over a grab bag —');
    console.log('  a themed release can be reviewed and rolled back; a mixed one cannot.');
  }
  console.log('\n  The Release Manager writes the plan. Scope freeze is explicit.\n');
  record('plan', 'reported');
}

function release() {
  try {
    execFileSync(process.execPath, ['scripts/release-gate.mjs'], { stdio: 'inherit' });
    record('release', 'gate-passed');
  } catch {
    record('release', 'gate-blocked', ['release gate refused']);
    process.exitCode = 1;
  }
}

function verify() {
  const plan = read(join(AI, 'release-plan.json'));
  const current = plan?.currentRelease;
  console.log(`\n  LIVE VERIFICATION  ${today()}\n`);
  if (!current) {
    console.log('  No current release.\n');
    record('verify', 'no-release');
    return;
  }
  const evidence = current.liveVerification ?? {};
  const required = ['health', 'smoke', 'securityProbes', 'provenance'];
  const missing = required.filter((k) => !evidence[k]);
  for (const key of required) console.log(`  ${evidence[key] ? 'PASS' : 'MISSING'}  ${key}`);
  console.log(
    missing.length === 0
      ? '\n  Live evidence complete.\n'
      : `\n  INCOMPLETE — ${missing.join(', ')}. A workflow reporting success is not evidence;\n  the live endpoint is.\n`,
  );
  record('verify', missing.length === 0 ? 'complete' : 'incomplete', missing);
  if (missing.length) process.exitCode = 1;
}

const phases = { discover, council, plan, release, verify };
if (!phases[phase]) {
  console.error(`Usage: node scripts/product.mjs <${Object.keys(phases).join('|')}>`);
  process.exit(2);
}
phases[phase]();
