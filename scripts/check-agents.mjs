// Validates the agent team wiring. Run: node scripts/check-agents.mjs
//
// This exists because agent files that merely parse can still be wrong in ways
// that matter: a handoff pointing at a name nobody defines, two agents claiming
// one role, or a "read-only" reviewer that was quietly granted an edit tool.
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const dir = '.github/agents';
let failures = 0;
const check = (condition, message) => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${message}`);
  if (!condition) failures += 1;
};

// Absent, valid and unparseable are three different states. An uncaught
// JSON.parse would crash the whole validator mid-run on a corrupt file,
// silently skipping every check after it; that is worse than reporting a
// clear FAIL and continuing, which is what this does instead.
const readJSON = (path) => {
  if (!existsSync(path)) {
    check(false, `${path} is readable (missing)`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    check(false, `${path} is valid JSON (${error.message})`);
    return null;
  }
};

const agents = {};
for (const file of readdirSync(dir)) {
  const text = readFileSync(`${dir}/${file}`, 'utf8');
  const matter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!matter) {
    check(false, `frontmatter parses: ${file}`);
    continue;
  }
  const block = matter[1];
  const field = (key) => (block.match(new RegExp(`^${key}:\\s*(.+)$`, 'm')) ?? [])[1]?.trim() ?? '';
  // Prettier rewraps long YAML arrays into block style, so both forms are
  // valid and both appear in this directory. Matching only the inline form
  // made this validator silently pass a file it had failed to read.
  const list = (key) => {
    const inline = block.match(new RegExp(`^${key}:\\s*\\[([^\\]]*)\\]`, 'm'));
    const wrapped = block.match(new RegExp(`^${key}:\\s*\\n\\s*\\[([\\s\\S]*?)\\]`, 'm'));
    const raw = (inline ?? wrapped ?? [])[1] ?? '';
    return raw
      .split(',')
      .map((s) => s.trim().replace(/'/g, ''))
      .filter(Boolean);
  };
  agents[file] = {
    name: field('name'),
    description: field('description'),
    target: field('target'),
    tools: list('tools'),
    delegatesTo: list('agents'),
  };
}

const files = Object.keys(agents);
const named = Object.values(agents);

check(files.length === 24, `24 agent files (got ${files.length})`);
check(
  named.every((a) => a.name && a.description && a.target === 'vscode'),
  'every agent has name, description and target: vscode',
);
check(new Set(named.map((a) => a.name)).size === files.length, 'agent names are unique');

const names = new Set(named.map((a) => a.name));
const dangling = files.flatMap((f) =>
  agents[f].delegatesTo.filter((t) => !names.has(t)).map((t) => `${f} -> ${t}`),
);
check(dangling.length === 0, `handoff targets resolve ${dangling.join('; ')}`);

// Only the orchestrator may delegate. Any other delegator can create a cycle.
const delegators = files.filter((f) => agents[f].delegatesTo.length > 0);
check(
  delegators.length === 1 && delegators[0].includes('orchestrator'),
  `only the orchestrator delegates (${delegators.join(', ') || 'none'})`,
);

// Read-only is a tool grant, not a promise in prose.
for (const role of [
  'product-architect',
  'ux-agent',
  'security-agent',
  'final-auditor',
  'research-agent',
  'system-designer',
  'independent-reviewer',
  'research-reference',
  'project-manager-client',
  'code-quality',
  'product-discovery',
  'agent-operations',
  'skills-curator',
]) {
  const file = files.find((f) => f.includes(role));
  check(file && !agents[file].tools.includes('edit'), `${role} has no edit tool`);
}

for (const role of [
  'frontend-agent',
  'backend-agent',
  'infrastructure-agent',
  'senior-engineer',
  'visual-designer',
  'documentation',
  'repository',
  'release-manager',
]) {
  const file = files.find((f) => f.includes(role));
  check(
    file && agents[file].tools.includes('edit') && agents[file].tools.includes('execute'),
    `${role} can edit and execute`,
  );
}

// QA and Performance must run commands but must not edit implementation.
for (const role of ['qa-agent', 'performance-agent']) {
  const file = files.find((f) => f.includes(role));
  check(
    file && agents[file].tools.includes('execute') && !agents[file].tools.includes('edit'),
    `${role} can execute but not edit`,
  );
}

const state = [
  'PROJECT-CONTEXT',
  'REQUIREMENTS',
  'ARCHITECTURE',
  'SYSTEM-DESIGN',
  'UX-DESIGN',
  'DECISIONS',
  'ACTIVE-TASK',
  'PLAN',
  'PLAN-REVIEW',
  'IMPLEMENTATION-LOG',
  'CODE-REVIEW',
  'SECURITY-REPORT',
  'PERFORMANCE-REPORT',
  'QA-REPORT',
  'FINAL-AUDIT',
  'DOCUMENTATION-AUDIT',
  'CLEANUP-REPORT',
  'CAREERSCOPE-PROGRESS',
  'AGENT-SETUP',
]
  .map((n) => `${n}.md`)
  .concat('LOOP-STATE.json');

const missing = state.filter((f) => !existsSync(`.ai/${f}`));
check(missing.length === 0, `all 20 .ai files exist ${missing.join(', ')}`);

// The audit log is append-only and lives in the canonical .ai state directory.
check(existsSync('.ai/review-log.txt'), '.ai/review-log.txt exists');
// The progress file must carry a real overall status line. Parse it rather than
// scanning for a substring: an earlier version of this validator passed because
// its regex silently failed to match, which is the exact failure mode being
// guarded against here. Absent must report a named FAIL, not crash the rest of
// this validator uncaught - that was itself a live CS-8 defect (see finding R4).
const progressText = existsSync('.ai/CAREERSCOPE-PROGRESS.md')
  ? readFileSync('.ai/CAREERSCOPE-PROGRESS.md', 'utf8')
  : null;
check(progressText !== null, '.ai/CAREERSCOPE-PROGRESS.md is readable');
const overall =
  progressText !== null ? /^\*\*Overall Status:\*\*\s*(.+)$/m.exec(progressText) : null;
check(overall !== null, 'progress file states an overall status');
check(
  overall !== null && /^(IN PROGRESS|BLOCKED|COMPLETE)\b/.test(overall[1]),
  `overall status is a known value (${overall ? overall[1].slice(0, 40) : 'absent'})`,
);

// Section 39 defines the status vocabulary. Anything else is drift, and an
// invented value like PARTIAL hides whether a thing was ever actually verified.
const allowed = new Set([
  'NOT STARTED',
  'IN PROGRESS',
  'IMPLEMENTED',
  'VERIFIED',
  'COMPLETE',
  'BLOCKED',
]);
// Scoped to the matrices: the Open items table records dispositions, not statuses.
// progressText is null when the file was absent (already reported above); an
// empty string here makes matrices come back empty and the next two checks
// fail loudly and by name, instead of throwing on progressText.slice(...).
const matrices = (progressText ?? '').slice(
  (progressText ?? '').indexOf('## Overall Progress'),
  (progressText ?? '').indexOf('## Open items'),
);
const statuses = [
  ...matrices.matchAll(
    /^\|[^|\r\n]+\|(?:[^|\r\n]*\|)*\s*(NOT STARTED|IN PROGRESS|IMPLEMENTED|VERIFIED|COMPLETE|BLOCKED)\s*\|$/gm,
  ),
].map((m) => m[1]);
const unknown = [...new Set(statuses)].filter((s) => !allowed.has(s));
check(
  statuses.length >= 12,
  `progress matrices cover the 12 canonical areas (${statuses.length} status cells)`,
);
check(unknown.length === 0, `every status is a defined value ${unknown.join(', ')}`);

// Structured state is canonical; the Markdown is the human projection. Drift
// between them has to be caught here, or the projection quietly becomes fiction.
for (const file of ['progress.json', 'findings.json', 'references.json']) {
  check(existsSync(`.ai/${file}`), `structured state exists: ${file}`);
}
for (const file of [
  'backlog.json',
  'product-discovery.json',
  'release-plan.json',
  'agent-operations.json',
  'skill-registry.json',
]) {
  check(existsSync(`.ai/${file}`), `product state exists: ${file}`);
}
check(existsSync('scripts/release-gate.mjs'), 'release gate script exists');
// The scheduler must stay off until the gates it depends on are proven.
const releasePlan = readJSON('.ai/release-plan.json');
check(
  releasePlan !== null && releasePlan.schedulerEnabled === false,
  `scheduled operation is disabled (${releasePlan?.schedulerEnabled})`,
);
const canonical = readJSON('.ai/progress.json');
// An em dash means deliberately unmeasured and must equal null in the JSON.
// This widens what the projection can read, not what counts as agreement:
// 70 against 85, or a dash against a number, still drift.
const projected = new Map(
  [...matrices.matchAll(/^\|\s*([A-Za-z/ ]+?)\s*\|\s*(\d+%|—)/gm)].map((m) => [
    m[1],
    m[2] === '—' ? null : Number(m[2].slice(0, -1)),
  ]),
);
const areas = canonical?.areas ?? [];
const drifted = areas.filter((a) => projected.get(a.area) !== a.percent);
check(
  canonical !== null && areas.length === 12,
  `progress.json covers 12 areas (${canonical === null ? 'unreadable' : areas.length})`,
);
check(
  canonical !== null && drifted.length === 0,
  `progress.json and the Markdown agree ${drifted.map((a) => `${a.area} json=${a.percent} md=${projected.get(a.area)}`).join(', ')}`,
);

const loop = readJSON('.ai/LOOP-STATE.json');
check(
  loop !== null && loop.status !== 'COMPLETE',
  `LOOP-STATE not falsely complete (${loop?.status})`,
);
check(
  loop !== null && Object.keys(loop.agents ?? {}).length === files.length,
  `LOOP-STATE tracks every agent (${loop === null ? 'unreadable' : Object.keys(loop.agents ?? {}).length} of ${files.length})`,
);

// The control center renders these, so their absence would silently degrade it
// to a screen that shows nothing rather than one that reports a problem.
// loop is null when LOOP-STATE.json was missing or unparseable; readJSON
// already recorded that FAIL above, so these fall through to their own
// clear FAILs instead of throwing on a null dereference.
const loopSafe = loop ?? {};
check(
  [
    'activeAgent',
    'model',
    'currentOperation',
    'startedAt',
    'updatedAt',
    'agents',
    'activity',
  ].every((key) => key in loopSafe),
  'LOOP-STATE carries the fields the control center renders',
);
// An agent recorded as running while no agent is active is the exact lie the
// dashboard exists to prevent.
const busy = Object.entries(loopSafe.agents ?? {}).filter(
  ([, state]) => !['WAITING', 'COMPLETE', 'PASSED', 'FAILED', 'BLOCKED'].includes(state),
);
check(
  loop !== null && (loopSafe.activeAgent !== null || busy.length === 0),
  `no agent is recorded busy without an active agent ${busy.map(([id]) => id).join(', ')}`,
);
check(existsSync('scripts/control-center.mjs'), 'control center script exists');
check(
  loop !== null &&
    loopSafe.limits?.planReview === 5 &&
    loopSafe.limits?.implementation === 3 &&
    loopSafe.limits?.finalAudit === 2,
  'loop bounds present',
);

// A secret in shared state would be read by every agent and committed. An
// absent file is already reported by the "all 20 .ai files exist" check
// above; it is not re-reported here, and it must not crash this scan the way
// it previously did (Independent Reviewer finding on CS-8: this unconditional
// readFileSync threw uncaught on the very file readJSON() was fixed to guard,
// skipping every check after it, including this one and the final summary).
const leaky = state.filter((f) => {
  if (!existsSync(`.ai/${f}`)) return false;
  return /BEGIN (?:RSA|OPENSSH|EC) PRIVATE|ghp_[A-Za-z0-9]{20}|postgres:\/\/[^\s]*:[^\s@]+@/.test(
    readFileSync(`.ai/${f}`, 'utf8'),
  );
});
check(leaky.length === 0, `no secrets in .ai ${leaky.join(', ')}`);

console.log(failures === 0 ? '\nagent configuration valid' : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
