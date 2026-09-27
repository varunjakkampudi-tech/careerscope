import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import {
  CLAIMING_STATES,
  TASK_STATES,
  contractInputs,
  proveTaskContract,
  successfulEvidence,
  validateTaskContract,
} from './engineering-contract.mjs';

export const AREAS = [
  'architecture',
  'frontend',
  'backend',
  'database',
  'security',
  'accessibility',
  'performance',
  'seo',
  'testing',
  'ux',
  'documentation',
  'production-readiness',
];
const STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'BLOCKED', 'VERIFIED', 'COMPLETE'];
const finished = (status) => ['VERIFIED', 'COMPLETE'].includes(status);
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const requireThat = (condition, message) => {
  if (!condition) throw new Error(message);
};
const shape = (value, keys, label) => {
  requireThat(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${label}: object required`,
  );
  requireThat(
    Object.keys(value).length === keys.split(' ').length &&
      keys.split(' ').every((key) => Object.hasOwn(value, key)),
    `${label}: incorrect fields`,
  );
};
const unique = (values, label) =>
  requireThat(new Set(values).size === values.length, `${label}: duplicate values`);
const stamp = (value, label, now) => {
  requireThat(
    typeof value === 'string' &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value &&
      Date.parse(value) <= now,
    `${label}: canonical non-future ISO timestamp required`,
  );
};
const revisionShape = (value) =>
  typeof value === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value);
const digestShape = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const canonical = (value) =>
  JSON.stringify(value, function (_key, item) {
    return item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([left], [right]) => left.localeCompare(right, 'en')),
        )
      : item;
  });

export function normalizeClaim(value) {
  requireThat(text(value), 'files: nonempty relative path required');
  const normalized = value.replaceAll('\\', '/').replace(/\/$/, '');
  const parts = normalized.split('/');
  requireThat(
    parts.every(
      (part) =>
        part &&
        part !== '.' &&
        part !== '..' &&
        !/[<>:"|?*]/.test(part) &&
        ![...part].some((character) => character.charCodeAt(0) < 32) &&
        !/[. ]$/.test(part) &&
        !/^(con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(part),
    ),
    'files: unsafe or nonportable path',
  );
  requireThat(
    !parts.some(
      (part) =>
        ['.git', 'node_modules', 'data', 'private'].includes(part.toLowerCase()) ||
        (/^\.env(?:\.|$)/i.test(part) && part !== '.env.example'),
    ),
    'files: private or generated path is not allowed',
  );
  return normalized;
}
const overlaps = (left, right) =>
  left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);

export function contentDigest(state, gates, root) {
  const hash = createHash('sha256');
  const contract = {
    schemaVersion: state.schemaVersion,
    objective: state.objective,
    tasks: state.tasks.map(
      ({ id, owner, files, dependencies, attemptLimit, acceptanceCriteria, contract }) => ({
        id,
        owner,
        files,
        dependencies,
        attemptLimit,
        acceptanceCriteria,
        ...(state.schemaVersion === 2 ? { contract: contractInputs(contract) } : {}),
      }),
    ),
    areas: Object.fromEntries(
      Object.entries(gates.areas).map(
        ([area, { applicability, responsibleAgent, checks, knownIssues }]) => [
          area,
          { applicability, responsibleAgent, checks, knownIssues },
        ],
      ),
    ),
  };
  hash.update(canonical(contract));
  if (state.schemaVersion === 2)
    for (const task of state.tasks)
      hash.update(readFileSync(safeContractFile(root, task.contract.baseline)));
  const seen = new Map();
  let entries = 0;
  let bytes = 0;
  const visit = (relative) => {
    const safe = normalizeClaim(relative);
    const key = safe.toLowerCase();
    if (seen.has(key)) {
      requireThat(seen.get(key) === safe, 'files: case-alias collision');
      return;
    }
    seen.set(key, safe);
    requireThat(++entries <= 2000, 'scope exceeds 2000 entries; narrow file claims');
    let metadata;
    let current = root;
    for (const part of safe.split('/')) {
      current = join(current, part);
      try {
        metadata = lstatSync(current);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        hash.update(canonical([safe, 'missing']));
        return;
      }
      requireThat(
        !metadata.isSymbolicLink(),
        'files: symbolic links and junctions are not allowed',
      );
    }
    hash.update(canonical([safe, metadata.isDirectory() ? 'directory' : 'file']));
    if (metadata.isDirectory()) {
      for (const child of readdirSync(current).sort()) visit(`${safe}/${child}`);
    } else {
      requireThat(metadata.isFile(), 'files: regular files required');
      if (['.ai/engineering.json', 'quality-gates.json'].includes(key)) return;
      bytes += metadata.size;
      requireThat(bytes <= 16 * 1024 * 1024, 'scope exceeds 16 MiB; narrow file claims');
      hash.update(createHash('sha256').update(readFileSync(current)).digest());
    }
  };
  for (const file of [
    ...new Set(state.tasks.flatMap((task) => task.files).map(normalizeClaim)),
  ].sort())
    visit(file);
  return hash.digest('hex');
}

export function safeContractFile(root, path) {
  let current = resolve(root);
  for (const part of normalizeClaim(path).split('/')) {
    current = join(current, part);
    requireThat(!lstatSync(current).isSymbolicLink(), 'contract path: symbolic links forbidden');
  }
  const metadata = lstatSync(current);
  requireThat(
    metadata.isFile() && metadata.size <= 1024 * 1024,
    'contract path: regular file <= 1 MiB required',
  );
  return current;
}

export function validateEngineering(state, gates, { root, agents, revision, now = Date.now() }) {
  try {
    shape(
      state,
      'schemaVersion objective status revision createdAt updatedAt blockedReason tasks',
      'state',
    );
    shape(gates, 'schemaVersion areas', 'gates');
    requireThat(
      [1, 2].includes(state.schemaVersion) && gates.schemaVersion === 1,
      'unsupported schemaVersion',
    );
    requireThat(
      text(state.objective) && revisionShape(state.revision),
      'objective and revision required',
    );
    requireThat(
      agents instanceof Set && agents.size > 0 && revisionShape(revision),
      'agent registry and current revision required',
    );
    const agentIds = new Set([...agents].map((value) => value.toLowerCase()));
    const expanded = state.schemaVersion === 2;
    const taskFinished = (value) =>
      expanded ? ['PASSED', 'COMPLETE'].includes(value) : finished(value);
    const agent = (value) =>
      requireThat(
        typeof value === 'string' && agentIds.has(value.toLowerCase()),
        `unknown agent: ${String(value)}`,
      );
    const status = (record, label) =>
      requireThat(STATUSES.includes(record.status), `${label}: invalid status`);
    const dates = (record, label) => {
      stamp(record.createdAt, `${label}.createdAt`, now);
      stamp(record.updatedAt, `${label}.updatedAt`, now);
      requireThat(
        record.createdAt <= record.updatedAt &&
          record.createdAt >= state.createdAt &&
          record.updatedAt <= state.updatedAt,
        `${label}: inconsistent timestamps`,
      );
    };
    const blocked = (record, label) =>
      requireThat(
        record.status === 'BLOCKED' ? text(record.blockedReason) : record.blockedReason === null,
        `${label}: blockedReason must describe BLOCKED only`,
      );
    status(state, 'state');
    dates(state, 'state');
    blocked(state, 'state');
    requireThat(
      Array.isArray(state.tasks) && state.tasks.length > 0 && state.tasks.length <= 200,
      'tasks: 1..200 required',
    );
    shape(gates.areas, AREAS.join(' '), 'areas');
    const checks = (values, label) => {
      requireThat(Array.isArray(values) && values.length > 0, `${label}: checks required`);
      for (const check of values) {
        shape(check, 'id description', label);
        requireThat(
          typeof check.id === 'string' &&
            /^[A-Za-z][A-Za-z0-9_-]*$/.test(check.id) &&
            text(check.description),
          `${label}: invalid check`,
        );
      }
      unique(
        values.map((check) => check.id),
        label,
      );
    };
    const reports = (
      evidence,
      review,
      owner,
      criteria,
      start,
      end,
      label,
      expandedReview = false,
    ) => {
      requireThat(Array.isArray(evidence), `${label}: evidence array required`);
      for (const item of evidence) {
        shape(item, 'id check kind command result revision digest recordedAt', `${label}.evidence`);
        requireThat(
          text(item.id) &&
            text(item.command) &&
            ['PASS', 'FAIL'].includes(item.result) &&
            revisionShape(item.revision) &&
            digestShape(item.digest),
          `${label}: invalid evidence`,
        );
        requireThat(
          (item.kind === 'acceptance' && criteria.some((check) => check.id === item.check)) ||
            (item.kind === 'regression' && item.check === 'regression'),
          `${label}: unknown evidence check`,
        );
        stamp(item.recordedAt, `${label}.recordedAt`, now);
        requireThat(
          item.recordedAt >= start && item.recordedAt <= end,
          `${label}: evidence outside task timestamps`,
        );
      }
      unique(
        evidence.map((item) => item.id),
        `${label}.evidence`,
      );
      if (review !== null) {
        shape(
          review,
          `agent verdict revision digest reviewedAt${expandedReview ? ' findings' : ''}`,
          `${label}.review`,
        );
        if (expandedReview)
          requireThat(
            Array.isArray(review.findings) &&
              review.findings.every(text) &&
              (review.verdict === 'APPROVED'
                ? review.findings.length === 0
                : review.findings.length > 0),
            `${label}: final review verdict requires consistent findings`,
          );
        agent(review.agent);
        requireThat(
          review.agent.toLowerCase() !== owner.toLowerCase(),
          `${label}: review must be independent`,
        );
        requireThat(
          ['APPROVED', 'CHANGES_REQUESTED'].includes(review.verdict) &&
            revisionShape(review.revision) &&
            digestShape(review.digest),
          `${label}: invalid review`,
        );
        stamp(review.reviewedAt, `${label}.reviewedAt`, now);
        requireThat(
          review.reviewedAt >= start &&
            review.reviewedAt <= end &&
            evidence.every((item) => item.recordedAt <= review.reviewedAt),
          `${label}: review must follow evidence`,
        );
      }
    };
    for (const task of state.tasks) {
      shape(
        task,
        `id owner files dependencies attempts attemptLimit status acceptanceCriteria evidence review createdAt updatedAt blockedReason${expanded ? ' contract' : ''}`,
        'task',
      );
      requireThat(
        typeof task.id === 'string' && /^[A-Za-z][A-Za-z0-9_-]*$/.test(task.id),
        'task: invalid ID',
      );
      agent(task.owner);
      if (expanded) requireThat(TASK_STATES.includes(task.status), `${task.id}: invalid status`);
      else status(task, task.id);
      dates(task, task.id);
      blocked(task, task.id);
      requireThat(
        Array.isArray(task.files) && task.files.length > 0,
        `${task.id}: file claims required`,
      );
      task.files.forEach(normalizeClaim);
      unique(
        task.files.map((file) => normalizeClaim(file).toLowerCase()),
        `${task.id}.files`,
      );
      requireThat(
        Array.isArray(task.dependencies) && task.dependencies.every(text),
        `${task.id}: dependencies required`,
      );
      unique(task.dependencies, `${task.id}.dependencies`);
      requireThat(
        Number.isSafeInteger(task.attemptLimit) &&
          task.attemptLimit >= 1 &&
          task.attemptLimit <= 20 &&
          Number.isSafeInteger(task.attempts) &&
          task.attempts >= 0 &&
          task.attempts <= task.attemptLimit,
        `${task.id}: invalid attempts`,
      );
      requireThat(
        expanded ||
          task.status !== 'IN_PROGRESS' ||
          (task.attempts > 0 && task.attempts < task.attemptLimit),
        `${task.id}: exhausted or unstarted active attempts`,
      );
      requireThat(
        task.status !== 'NOT_STARTED' || task.attempts === 0,
        `${task.id}: NOT_STARTED has attempts`,
      );
      requireThat(
        expanded || !finished(task.status) || task.attempts > 0,
        `${task.id}: finished task has no attempt`,
      );
      checks(task.acceptanceCriteria, task.id);
      reports(
        task.evidence,
        task.review,
        task.owner,
        task.acceptanceCriteria,
        task.createdAt,
        task.updatedAt,
        task.id,
        expanded,
      );
      if (expanded)
        validateTaskContract(task, {
          baseline: JSON.parse(
            readFileSync(safeContractFile(root, task.contract.baseline), 'utf8'),
          ),
          agents: agentIds,
          now,
          normalizePath: normalizeClaim,
          existingFile: (file) => safeContractFile(root, file),
        });
    }
    unique(
      state.tasks.map((task) => task.id),
      'tasks',
    );
    const tasks = new Map(state.tasks.map((task) => [task.id, task]));
    const visiting = new Set();
    const visited = new Set();
    const visit = (id) => {
      requireThat(tasks.has(id), `missing dependency: ${id}`);
      requireThat(!visiting.has(id), `dependency cycle: ${id}`);
      if (visited.has(id)) return;
      visiting.add(id);
      tasks.get(id).dependencies.forEach(visit);
      visiting.delete(id);
      visited.add(id);
    };
    tasks.forEach((task) => visit(task.id));
    const active = state.tasks.filter((task) =>
      expanded ? CLAIMING_STATES.includes(task.status) : task.status === 'IN_PROGRESS',
    );
    const conflict = (left, right) =>
      left.files.some((file) =>
        right.files.some((other) =>
          overlaps(normalizeClaim(file).toLowerCase(), normalizeClaim(other).toLowerCase()),
        ),
      );
    for (const [index, task] of active.entries()) {
      requireThat(
        !active.slice(index + 1).some((other) => conflict(task, other)),
        `${task.id}: active write overlap`,
      );
    }
    for (const [area, gate] of Object.entries(gates.areas)) {
      shape(
        gate,
        'status applicability responsibleAgent evidence checks knownIssues lastReviewed reviewer',
        area,
      );
      status(gate, area);
      agent(gate.responsibleAgent);
      shape(gate.applicability, 'applicable reason', `${area}.applicability`);
      requireThat(
        typeof gate.applicability.applicable === 'boolean' &&
          (gate.applicability.applicable
            ? gate.applicability.reason === null
            : text(gate.applicability.reason)),
        `${area}: applicability needs a reason when not applicable`,
      );
      checks(gate.checks, area);
      requireThat(
        Array.isArray(gate.knownIssues) && gate.knownIssues.every(text),
        `${area}: knownIssues array required`,
      );
      requireThat(
        gate.status !== 'BLOCKED' || gate.knownIssues.length > 0,
        `${area}: BLOCKED needs a known issue`,
      );
      reports(
        gate.evidence,
        gate.reviewer,
        gate.responsibleAgent,
        gate.checks,
        state.createdAt,
        state.updatedAt,
        area,
      );
      requireThat(
        gate.reviewer === null
          ? gate.lastReviewed === null
          : gate.lastReviewed === gate.reviewer.reviewedAt,
        `${area}: lastReviewed must match reviewer`,
      );
    }
    const digest = contentDigest(state, gates, root);
    const proof = (evidence, review, criteria, label) => {
      requireThat(state.revision === revision, `${label}: stale objective revision`);
      requireThat(
        evidence.length > 0 &&
          evidence.every(
            (item) =>
              item.result === 'PASS' && item.revision === revision && item.digest === digest,
          ),
        `${label}: successful same-revision content evidence required`,
      );
      requireThat(
        criteria.every((check) =>
          evidence.some((item) => item.kind === 'acceptance' && item.check === check.id),
        ) && evidence.some((item) => item.kind === 'regression'),
        `${label}: acceptance checks and regression result required`,
      );
      requireThat(
        review?.verdict === 'APPROVED' && review.revision === revision && review.digest === digest,
        `${label}: current independent approval required`,
      );
    };
    for (const task of state.tasks) {
      if (
        (expanded ? CLAIMING_STATES.includes(task.status) : task.status === 'IN_PROGRESS') ||
        taskFinished(task.status)
      )
        requireThat(
          task.dependencies.every((id) => tasks.get(id).status === 'COMPLETE'),
          `${task.id}: dependencies not COMPLETE`,
        );
      if (taskFinished(task.status)) {
        for (const file of task.files)
          requireThat(
            existsSync(resolve(root, normalizeClaim(file))),
            `${task.id}: claimed file missing: ${file}`,
          );
        if (expanded) proveTaskContract(task, { revision, digest });
        proof(
          expanded ? successfulEvidence(task.evidence, task.contract.failures) : task.evidence,
          task.review,
          task.acceptanceCriteria,
          task.id,
        );
      }
    }
    for (const [area, gate] of Object.entries(gates.areas)) {
      if (finished(gate.status)) {
        requireThat(gate.knownIssues.length === 0, `${area}: unresolved known issues`);
        requireThat(
          !gate.evidence.some((item) => item.result === 'FAIL'),
          `${area}: unresolved failed evidence`,
        );
        proof(gate.evidence, gate.reviewer, gate.checks, area);
      }
    }
    const completionErrors = [];
    for (const task of state.tasks)
      if (task.status !== 'COMPLETE') completionErrors.push(`${task.id}: not COMPLETE`);
    for (const [area, gate] of Object.entries(gates.areas)) {
      if (gate.applicability.applicable && !finished(gate.status))
        completionErrors.push(`${area}: not VERIFIED`);
      if (!gate.applicability.applicable) {
        if (gate.evidence.some((item) => item.result === 'FAIL'))
          completionErrors.push(`${area}: unresolved failed evidence`);
        if (
          gate.knownIssues.length ||
          !gate.reviewer ||
          gate.reviewer.verdict !== 'APPROVED' ||
          gate.reviewer.revision !== revision ||
          gate.reviewer.digest !== digest
        )
          completionErrors.push(
            `${area}: exclusion needs current independent approval and no known issues`,
          );
      }
    }
    requireThat(
      !finished(state.status) || completionErrors.length === 0,
      `objective completion contradicted: ${completionErrors.join('; ')}`,
    );
    if (state.status !== 'COMPLETE') completionErrors.push('objective: not COMPLETE');
    const ready =
      state.status === 'IN_PROGRESS' && state.revision === revision
        ? state.tasks
            .filter(
              (task) =>
                (expanded
                  ? task.status === 'READY' && task.contract.risk !== 'R5'
                  : task.status === 'NOT_STARTED') &&
                task.attempts < task.attemptLimit &&
                task.dependencies.every((id) => tasks.get(id).status === 'COMPLETE') &&
                !active.some((other) => conflict(task, other)),
            )
            .map((task) => task.id)
        : [];
    return {
      valid: true,
      assurance: expanded ? 'EXPANDED_V2' : 'LEGACY_V1',
      errors: [],
      digest,
      ready,
      complete: completionErrors.length === 0,
      completionErrors,
    };
  } catch (error) {
    return {
      valid: false,
      errors: [error.message],
      digest: null,
      ready: [],
      complete: false,
      completionErrors: ['invalid engineering records'],
    };
  }
}

export function readRevision(root) {
  let git = join(root, '.git');
  if (lstatSync(git).isFile()) {
    const pointer = /^gitdir: (.+)\r?\n?$/.exec(readFileSync(git, 'utf8'));
    requireThat(pointer, 'invalid git directory pointer');
    git = resolve(root, pointer[1]);
  }
  const head = readFileSync(join(git, 'HEAD'), 'utf8').replace(/\r?\n$/, '');
  if (revisionShape(head)) return head;
  const reference = head.slice(5);
  requireThat(
    head.startsWith('ref: refs/') &&
      !reference.includes('..') &&
      !reference.includes('@{') &&
      !reference.endsWith('.') &&
      !/[ ~^:?*[\\]/.test(reference) &&
      ![...reference].some((character) => {
        const code = character.codePointAt(0);
        return code < 32 || code === 127;
      }) &&
      reference
        .split('/')
        .every((part) => part && !part.startsWith('.') && !part.endsWith('.lock')),
    'invalid Git HEAD',
  );
  const readContained = (directory, path) => {
    const base = realpathSync(directory);
    const target = realpathSync(resolve(base, path));
    const offset = relative(base, target);
    requireThat(
      offset && !isAbsolute(offset) && offset.split(/[\\/]/)[0] !== '..',
      'Git reference escapes directory',
    );
    return readFileSync(target, 'utf8');
  };
  let common = git;
  try {
    common = resolve(git, readFileSync(join(git, 'commondir'), 'utf8').trim());
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const directory of new Set([git, common])) {
    try {
      const revision = readContained(directory, reference).trim();
      requireThat(revisionShape(revision), 'invalid Git revision');
      return revision;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const packed = readContained(common, 'packed-refs')
    .split(/\r?\n/)
    .find((line) => line.split(' ')[1] === reference)
    ?.split(' ')[0];
  requireThat(revisionShape(packed), 'missing Git revision');
  return packed;
}

export function loadEngineering(root) {
  const state = JSON.parse(readFileSync(join(root, '.ai/engineering.json'), 'utf8'));
  const gates = JSON.parse(readFileSync(join(root, 'quality-gates.json'), 'utf8'));
  const agents = new Set(
    readdirSync(join(root, '.github/agents'))
      .filter((name) => name.endsWith('.agent.md'))
      .map((name) => name.slice(0, -9)),
  );
  return {
    state,
    gates,
    result: validateEngineering(state, gates, { root, agents, revision: readRevision(root) }),
  };
}

const HELP = `Usage: node scripts/engineering.mjs <check|ready|status|verify|help>
Read-only local execution projection; product backlog is unchanged.
check: validate records and claimed results; honest BLOCKED is valid (exit 0).
ready: schema v1 NOT_STARTED; schema v2 READY, excluding R5. Requires an
IN_PROGRESS objective at current revision, attempts below attemptLimit, COMPLETE dependencies
and no active file conflicts. No execution.
Readiness policy: validateEngineering in engineering.mjs.
status: objective, task/gate statuses, digest, readiness and completion blockers.
verify: exit 0 only for a COMPLETE objective with all tasks COMPLETE and all
applicable gates VERIFIED/COMPLETE. Invalid/incomplete records exit 1.

Schema v1: .ai/engineering.json has objective, status, revision (Git HEAD),
createdAt/updatedAt (canonical UTC ISO), blockedReason (null unless BLOCKED),
tasks with id, owner, files, dependencies, attempts, attemptLimit, status,
acceptanceCriteria [{id,description}], evidence, review and the same timestamps.
Agent IDs are .github/agents filename stems, excluding .agent.md.
quality-gates.json has schemaVersion and areas (the twelve named quality areas).
Each area: status, applicability {applicable,reason}, responsibleAgent, evidence,
checks [{id,description}], knownIssues [string], lastReviewed, reviewer.
Evidence: {id,check,kind,command,result,revision,digest,recordedAt}; kind is
acceptance (check ID) or regression (check='regression'); result is PASS/FAIL.
review/reviewer: null or {agent,verdict,revision,digest,reviewedAt}; verdict is
APPROVED/CHANGES_REQUESTED. The reviewer must differ from the owner/responsibleAgent.
Exclusions need a reason and independent current approval for completion.
Statuses: ${STATUSES.join(', ')}. Active attempts must be below attemptLimit.

Schema v2 keeps the objective/gates v1 shape and extends every task with contract.
Task statuses: ${TASK_STATES.join(', ')}. files are existing regular files only.
contract: {risk: 'R0'..'R5', baseline: 'docs/ai/workflow-baseline.json', forbiddenPaths: [],
changedPaths: [], history: [{status:'CREATED',at:createdAt,actor:owner,findings:[]}],
checks: [{role:'documentation',checkId:'acceptance',applicable:true,reason:null}],
reviews: [], approvalRequired:false, humanApproval:null, failures:[]}.
Point baseline to a separately prepared strict baseline, not a historical report.
Do not mutate historical docs/ai/baseline.json to satisfy this schema.
Strict baseline example: {"schemaVersion":1,"failures":[]}
Only schemaVersion and failures are allowed; each failure is exactly
{checkId,signature}, both nonempty strings, with no duplicate pairs.
Baseline policy: validateBaseline in engineering-contract.mjs.
Role reviews: {role,agent,verdict,findings,revision,digest,reviewedAt}; verdict
APPROVED/REJECTED/BLOCKED. Human approval: {actor,approvedAt,reason}.
Failure: {id,checkId,command,at,exitCode,result,signature,classification,introducedBy,
phase,attempt,strategy,nextAction,resolvedBy}; classification BASELINE_EXISTING,
REGRESSION_INTRODUCED or UNKNOWN; phase INITIAL (attempt 0), then REMEDIATION
(1..3). resolvedBy links a successful evidence ID for the same command/check.
Failed results may have exitCode 0 (semantic failure) or null (no exit code).
attempts counts retained remediation failures, attemptLimit is 3. Unresolved
third remediation requires ESCALATED. No repeated strategy or counter reset.
Risk role/check requirements are exported as RISK_ROLES in engineering-contract.mjs.
Only testing/performance in R1/R2 can be excluded with reason and role approval.
R4 can declare approvalRequired; R5 requires approval before assignment and is
never automatically ready. Absent required approval means BLOCKED, with findings.
Replay starts CREATED; no fabricated migration history. Keep old records v1 when
their actual history is unavailable; create a new v2 objective/task instead.
New tasks use attempts:0, attemptLimit:3, status:CREATED, evidence:[], review:null.
After editing contract/execution history inputs, compute digest, record evidence,
enter REVIEW, bind role reviews, then obtain final independent approval before
PASSED and COMPLETE. Approval must follow REVIEW and all role reviews.
Role reviews, evidence, failure resolvedBy links and the trailing finding-free
REVIEW/PASSED/COMPLETE events are excluded from digest self-reference;
resolution links still require successful current reruns. Execution/failure history,
all other contract fields and baseline bytes remain bound. V2 final review adds
findings: [] for APPROVED, nonempty findings for CHANGES_REQUESTED.
Gate rules and gate failure retention stay v1 (no gate supersession).
Legacy check outputs assurance LEGACY_V1, never expanded v2 assurance.
Opt-in command execution is separate: engineering-runner.mjs help|list|run <id>.

Digest binds scoped bytes (including missing paths and directory membership) and
objective/task/check/applicability/known-issue definitions. State reporting fields
are excluded to avoid self-reference. Changes require fresh evidence and review.
Paths are relative, literal, case-insensitive for conflicts; no symlinks, private
data, .git or node_modules. Scope limit: 2000 entries / 16 MiB. Narrow claims.
No subprocesses, LLMs, agents, writes or deployment. Commands are reports only.
LIMITATION: this validates consistency, not truthfulness, reviewer identity,
undeclared scope, actual test execution or runtime discovery of agent files.
`;

export function main(
  args = process.argv.slice(2),
  root = dirname(dirname(fileURLToPath(import.meta.url))),
) {
  if (args.length === 0 || (args.length === 1 && ['help', '--help', '-h'].includes(args[0]))) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.length !== 1 || !['check', 'ready', 'status', 'verify'].includes(args[0])) {
    process.stderr.write('Unknown command or extra arguments. Use help.\n');
    return 1;
  }
  try {
    const { state, gates, result } = loadEngineering(root);
    const output =
      args[0] === 'ready' && result.valid
        ? { ready: result.ready, digest: result.digest }
        : args[0] === 'status'
          ? {
              objective: state.objective,
              status: state.status,
              tasks: state.tasks?.map(({ id, status }) => ({ id, status })),
              gates: Object.fromEntries(
                Object.entries(gates.areas ?? {}).map(([area, gate]) => [area, gate.status]),
              ),
              ...result,
            }
          : result;
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return result.valid && (args[0] !== 'verify' || result.complete) ? 0 : 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ valid: false, errors: [error.message] })}\n`);
    return 1;
  }
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
)
  process.exitCode = main();
