#!/usr/bin/env node
/**
 * Agile operating system for CareerScope.
 *
 * These commands prepare, validate and record sprint state. **They do not run
 * agents** — VS Code cannot invoke an agent from a shell. Each command tells you
 * which agents the Orchestrator should convene and in what order; the
 * Orchestrator drives them. Claiming otherwise would be fabricated automation.
 *
 *   npm run agile:status     where the sprint actually is
 *   npm run agile:plan       open Monday sprint planning
 *   npm run agile:scrum      open today's daily scrum record
 *   npm run agile:feature    check WIP and show the feature pipeline
 *   npm run agile:review     sprint review readiness
 *   npm run agile:release    release gate
 *   npm run agile:retro      open the retrospective
 *   npm run agile:carry      close the week and carry unfinished work forward
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const AI = '.ai';
const MAX_ACTIVE_FEATURES = 2;

const read = (p, fallback = null) =>
  existsSync(p) ? JSON.parse(readFileSync(p, 'utf8').replace(/\r\n/g, '\n')) : fallback;
const write = (p, v) => writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);
const today = () => new Date().toISOString().slice(0, 10);

/** ISO week, so a sprint id is stable regardless of when in the week it is asked for. */
function isoWeek(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

const git = (args, fallback = null) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  } catch {
    return fallback;
  }
};

const ACTIVE = ['IN_PROGRESS', 'CODE_REVIEW', 'QA', 'SECURITY'];
// One definition of finished. `review` and `carry` disagreeing on this meant a
// released item was reviewed as done and carried forward as unfinished.
const COMPLETE = 'RELEASED';
const sprintPath = () => join(AI, 'sprints', `${isoWeek()}.json`);

/** One sprint shape. Two literals drift the moment a field is added to either. */
function sprintSkeleton(id, { startDate = null, targetReleaseDate = null } = {}) {
  return {
    sprintId: id,
    week: id,
    goal: null,
    startDate,
    targetReleaseDate,
    status: 'PLANNING',
    candidates: [],
    selectedFeatures: [],
    deferredFeatures: [],
    rejectedFeatures: [],
    risks: [],
    dependencies: [],
    acceptanceCriteria: [],
    agents: [],
    releasePlan: {},
  };
}

/**
 * Read canonical state that a report depends on. Absent and unreadable are both
 * refusals: a board showing "0 open P0" because it could not open the file is
 * the defect this project keeps rediscovering.
 */
function readRequired(path) {
  if (!existsSync(path)) {
    console.error(`\n  ${path} is missing. Refusing to report a state I cannot read.\n`);
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8').replace(/\r\n/g, '\n'));
  } catch (error) {
    console.error(`\n  ${path} is unreadable: ${error.message}. Refusing to report.\n`);
    process.exit(1);
  }
}

/** Paused is a state the tooling has to honour, or pausing means nothing. */
function processMode() {
  const path = join(AI, 'process-mode.json');
  if (!existsSync(path)) return { mode: 'ACTIVE' };
  try {
    return JSON.parse(readFileSync(path, 'utf8').replace(/\r\n/g, '\n'));
  } catch (error) {
    console.error(`\n  ${path} is unreadable: ${error.message}. Refusing to guess the mode.\n`);
    process.exit(1);
  }
}

function refuseWhilePaused(command) {
  const m = processMode();
  if (m.mode !== 'PAUSED') return false;
  if (!Array.isArray(m.paused) || !m.paused.includes(`agile:${command}`)) return false;
  console.log(`\n  SPRINT PROCESS PAUSED  until ${m.resumeOn ?? 'further notice'}\n`);
  console.log(`  ${m.reason ?? ''}\n`);
  console.log(`  agile:${command} is paused. Still running:`);
  for (const line of m.stillActive ?? []) console.log(`    - ${line}`);
  console.log(`\n  Resume when: ${m.resumeCondition ?? 'unspecified'}`);
  console.log(`  To resume, set mode to ACTIVE in .ai/process-mode.json.\n`);
  record(command, 'paused');
  return true;
}

function record(phase, result, errors = []) {
  const path = join(AI, 'runs.json');
  const log = read(path, { runs: [] });
  log.runs.push({
    runId: `${phase}-${Date.now()}`,
    phase,
    startedAt: started,
    completedAt: new Date().toISOString(),
    commit: git(['rev-parse', 'HEAD']),
    branch: git(['branch', '--show-current']),
    result,
    errors,
  });
  log.runs = log.runs.slice(-200);
  log.updatedAt = new Date().toISOString();
  write(path, log);
}
const started = new Date().toISOString();

function status() {
  const sprint = read(sprintPath());
  const mode = processMode();
  if (mode.mode === 'PAUSED') {
    console.log(`\n  SPRINT PROCESS PAUSED  until ${mode.resumeOn ?? 'further notice'}`);
    console.log(`  ${mode.reason ?? ''}`);
  }
  const backlog = readRequired(join(AI, 'backlog.json'));
  const findings = readRequired(join(AI, 'findings.json'));
  const plan = read(join(AI, 'release-plan.json'), {});
  const branch = git(['branch', '--show-current'], 'unknown');
  const open = (findings.findings ?? []).filter(
    (f) => f.status !== 'FIXED' && f.status !== 'CLOSED',
  );
  const counts = (status_) => backlog.items.filter((i) => i.status === status_).length;

  console.log(`\n  CAREERSCOPE  ${isoWeek()}\n`);
  console.log(
    `  Branch        ${branch}${branch === 'main' ? '   (feature work belongs on a branch)' : ''}`,
  );
  console.log(`  Commit        ${git(['rev-parse', '--short', 'HEAD'], '?')}`);
  console.log(`  Sprint        ${sprint ? `${sprint.sprintId}  ${sprint.status}` : 'not planned'}`);
  console.log(`  Goal          ${sprint?.goal ?? '—'}`);
  console.log(`  Target        ${sprint?.targetReleaseDate ?? '—'}`);
  console.log(`\n  BACKLOG`);
  for (const s of [
    'READY',
    'PLANNED',
    'IN_PROGRESS',
    'CODE_REVIEW',
    'QA',
    'SECURITY',
    'BLOCKED',
    'RELEASED',
  ]) {
    const n = counts(s);
    if (n) console.log(`    ${s.padEnd(14)} ${n}`);
  }
  if (backlog.items.length === 0) console.log('    empty');
  const active = backlog.items.filter((i) => ACTIVE.includes(i.status));
  console.log(
    `\n  WIP           ${active.length}/${MAX_ACTIVE_FEATURES}${active.length > MAX_ACTIVE_FEATURES ? '   OVER LIMIT' : ''}`,
  );
  console.log(
    `  Open P0/P1    ${open.filter((f) => f.severity === 'P0').length}/${open.filter((f) => f.severity === 'P1').length}`,
  );
  console.log(`  Scheduler     ${plan.schedulerEnabled ? 'ENABLED' : 'disabled'}`);
  console.log();
  record('status', 'reported');
}

function plan() {
  mkdirSync(join(AI, 'sprints'), { recursive: true });
  const path = sprintPath();
  if (existsSync(path)) {
    console.log(
      `\n  Sprint already planned: ${path}\n  Editing a locked sprint silently is scope creep; change it explicitly.\n`,
    );
    record('plan', 'already-exists');
    return;
  }
  const start = new Date();
  const friday = new Date(start);
  friday.setDate(friday.getDate() + ((5 - friday.getDay() + 7) % 7));
  write(
    path,
    sprintSkeleton(isoWeek(), {
      startDate: today(),
      targetReleaseDate: friday.toISOString().slice(0, 10),
    }),
  );
  console.log(`\n  SPRINT PLANNING  ${isoWeek()}`);
  console.log(`  Created ${path}\n`);
  console.log('  Convene, in order, each contributing only from its responsibility:');
  console.log('    Product Discovery → Research → Project Manager → UX → System Designer');
  console.log('    → Backend/Frontend/Infrastructure impact → Security → Documentation');
  console.log('    → Code Quality → Orchestrator\n');
  console.log('  ONE sprint goal. Features either support it or are marked maintenance.\n');
  record('plan', 'opened');
}

function scrum() {
  mkdirSync(join(AI, 'scrum'), { recursive: true });
  const path = join(AI, 'scrum', `${today()}.json`);
  if (existsSync(path)) {
    console.log(`\n  Scrum record already exists: ${path}\n`);
    record('scrum', 'already-exists');
    return;
  }
  const sprint = read(sprintPath());
  write(path, {
    date: today(),
    sprint: sprint?.sprintId ?? null,
    sprintGoal: sprint?.goal ?? null,
    commit: git(['rev-parse', 'HEAD']),
    contributions: [],
    yesterday: [],
    today: [],
    blockers: [],
    decisions: [],
    newFeatures: [],
    removedFeatures: [],
    risks: [],
    nextRelease: null,
  });
  console.log(`\n  DAILY SCRUM  ${today()}`);
  console.log(`  Created ${path}\n`);
  console.log('  Bounded contributions only. Each participant answers:');
  console.log('    what changed · what completed · what is in progress · what is blocked');
  console.log('    · what changed in scope · what evidence exists · what is next\n');
  console.log('  Convene only the agents relevant to the current features.');
  console.log('  Adding agents to make the meeting look larger wastes everyone.\n');
  record('scrum', 'opened');
}

function feature() {
  const backlog = read(join(AI, 'backlog.json'), { items: [] });
  const active = backlog.items.filter((i) => ACTIVE.includes(i.status));
  console.log(`\n  FEATURE PIPELINE\n`);
  const STEPS = [
    'Project Manager',
    'Research',
    'UX',
    'System Designer',
    'Backend',
    'Frontend',
    'QA',
    'Security',
    'Independent Reviewer',
    'Documentation',
    'Final Auditor',
    'Orchestrator',
  ];
  if (active.length === 0) console.log('  No features in progress.');
  for (const item of active) {
    console.log(`  ${item.id}  ${item.title}   [${item.status}]  owner: ${item.ownerAgent ?? '—'}`);
    for (const [index, step] of STEPS.entries()) {
      const done = (item.completedSteps ?? []).includes(step);
      const current = item.currentStep === step;
      console.log(
        `     ${String(index + 1).padStart(2)}  ${done ? 'DONE    ' : current ? 'RUNNING ' : 'WAITING '} ${step}`,
      );
    }
    console.log();
  }
  const over = active.length > MAX_ACTIVE_FEATURES;
  console.log(
    `  WIP ${active.length}/${MAX_ACTIVE_FEATURES}${over ? '  OVER LIMIT — finish before starting more' : ''}\n`,
  );
  record('feature', over ? 'wip-exceeded' : 'ok', over ? ['WIP limit exceeded'] : []);
  if (over) process.exitCode = 1;
}

function review() {
  const sprint = read(sprintPath());
  if (!sprint) {
    console.log('\n  No sprint for this week.\n');
    record('review', 'no-sprint');
    process.exitCode = 1;
    return;
  }
  const backlog = readRequired(join(AI, 'backlog.json'));
  const selected = sprint.selectedFeatures ?? [];
  const done = backlog.items.filter((i) => selected.includes(i.id) && i.status === COMPLETE);
  const carried = selected.filter((id) => !done.some((d) => d.id === id));
  console.log(`\n  SPRINT REVIEW  ${sprint.sprintId}\n`);
  console.log(`  Goal        ${sprint.goal ?? '—'}`);
  console.log(`  Selected    ${selected.length}`);
  console.log(`  Released    ${done.length}`);
  console.log(
    `  Carried     ${carried.length}${carried.length ? `  (${carried.join(', ')})` : ''}`,
  );
  console.log('\n  Carried work is not failure; hiding it is. It moves to the next sprint.\n');
  record('review', 'reported');
}

function retro() {
  mkdirSync(join(AI, 'sprints'), { recursive: true });
  const path = join(AI, 'sprints', `${isoWeek()}-retrospective.json`);
  if (existsSync(path)) {
    console.log(`\n  Retrospective already exists: ${path}\n`);
    record('retro', 'already-exists');
    return;
  }
  write(path, {
    sprint: isoWeek(),
    date: today(),
    wentWell: [],
    failed: [],
    blocked: [],
    validatorsThatFailed: [],
    escapedDefects: [],
    reassignments: [],
    wrongAssumptions: [],
    changeNextSprint: [],
  });
  console.log(`\n  RETROSPECTIVE  ${isoWeek()}`);
  console.log(`  Created ${path}\n`);
  console.log('  Only actionable findings feed the next backlog. A retrospective that');
  console.log('  produces a list of feelings and no changes is a meeting, not a retro.\n');
  record('retro', 'opened');
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

/**
 * Move unfinished work into next week's sprint, explicitly.
 *
 * Work that quietly disappears at the end of a week is how a backlog starts
 * lying. Carrying an item records that it was carried and how many times, so a
 * item on its fourth week is visible as a problem rather than as normal.
 */
function carry() {
  const from = sprintPath();
  const sprint = read(from);
  if (!sprint) {
    console.error(`\n  No sprint at ${from}. Nothing to carry.\n`);
    record('carry', 'no-sprint', ['no current sprint']);
    process.exitCode = 1;
    return;
  }

  const backlog = read(join(AI, 'backlog.json'));
  if (!backlog || !Array.isArray(backlog.items)) {
    // An unreadable backlog is not an empty one.
    console.error('\n  .ai/backlog.json is missing or has no items array. Refusing to carry.\n');
    record('carry', 'backlog-unreadable', ['backlog unreadable']);
    process.exitCode = 1;
    return;
  }

  const byId = new Map(backlog.items.map((i) => [i.id, i]));
  const selected = Array.isArray(sprint.selectedFeatures) ? sprint.selectedFeatures : [];
  const unknown = selected.filter((id) => !byId.has(id));
  if (unknown.length) {
    console.error(`\n  Sprint names items absent from the backlog: ${unknown.join(', ')}\n`);
    record('carry', 'unknown-items', unknown);
    process.exitCode = 1;
    return;
  }

  const done = selected.filter((id) => byId.get(id).status === COMPLETE);
  const unfinished = selected.filter((id) => byId.get(id).status !== COMPLETE);

  const next = isoWeek(new Date(Date.now() + 7 * 86400000));
  const nextPath = join(AI, 'sprints', `${next}.json`);
  const target = read(nextPath, sprintSkeleton(next));

  for (const id of unfinished) {
    if (!target.candidates.includes(id)) target.candidates.push(id);
    const item = byId.get(id);
    item.carriedCount = (item.carriedCount ?? 0) + 1;
    item.carriedFrom = [...new Set([...(item.carriedFrom ?? []), sprint.sprintId])];
    item.updatedAt = today();
  }

  sprint.status = 'CLOSED';
  sprint.closedAt = today();
  sprint.outcome = { completed: done, carried: unfinished, carriedTo: next };

  write(from, sprint);
  write(nextPath, target);
  write(join(AI, 'backlog.json'), backlog);

  console.log(`\n  SPRINT CARRY  ${sprint.sprintId} → ${next}\n`);
  console.log(`  Completed: ${done.length ? done.join(', ') : 'none'}`);
  console.log(`  Carried:   ${unfinished.length ? unfinished.join(', ') : 'none'}\n`);
  for (const id of unfinished) {
    const item = byId.get(id);
    const times = item.carriedCount;
    console.log(
      `    ${id}  ${item.status.padEnd(12)} carried ${times}×${times >= 3 ? '  ← slice it or drop it' : ''}`,
    );
  }
  console.log(
    `\n  Carrying is not progress. ${unfinished.length} item(s) moved to ${next} as candidates,\n  not as commitments — next week's plan still has to select them.\n`,
  );
  record('carry', 'carried', []);
}

const commands = { status, plan, scrum, feature, review, retro, release, carry };
const command = process.argv[2];
if (!commands[command]) {
  console.error(`Usage: node scripts/agile.mjs <${Object.keys(commands).join('|')}>`);
  process.exit(2);
}
// release is a safety control, and status only reports. Neither is ceremony.
if (!refuseWhilePaused(command)) commands[command]();
