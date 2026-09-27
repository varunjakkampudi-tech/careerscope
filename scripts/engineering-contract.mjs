export const TASK_STATES = [
  'CREATED',
  'READY',
  'ASSIGNED',
  'IN_PROGRESS',
  'WAITING',
  'IMPLEMENTED',
  'VERIFYING',
  'REVIEW',
  'PASSED',
  'COMPLETE',
  'BLOCKED',
  'FAILED',
  'REJECTED',
  'NEEDS_REWORK',
  'ESCALATED',
];
export const CLAIMING_STATES = [
  'ASSIGNED',
  'IN_PROGRESS',
  'WAITING',
  'IMPLEMENTED',
  'VERIFYING',
  'REVIEW',
  'PASSED',
];
const EDGES = {
  CREATED: ['READY', 'BLOCKED'],
  READY: ['ASSIGNED', 'BLOCKED'],
  ASSIGNED: ['IN_PROGRESS', 'BLOCKED'],
  IN_PROGRESS: ['WAITING', 'IMPLEMENTED', 'BLOCKED', 'FAILED'],
  WAITING: ['IN_PROGRESS', 'BLOCKED', 'FAILED'],
  IMPLEMENTED: ['VERIFYING', 'NEEDS_REWORK', 'BLOCKED'],
  VERIFYING: ['REVIEW', 'FAILED', 'BLOCKED'],
  REVIEW: ['PASSED', 'REJECTED', 'BLOCKED'],
  PASSED: ['COMPLETE', 'NEEDS_REWORK', 'BLOCKED'],
  COMPLETE: [],
  BLOCKED: ['READY', 'NEEDS_REWORK', 'ESCALATED'],
  FAILED: ['NEEDS_REWORK', 'ESCALATED'],
  REJECTED: ['NEEDS_REWORK', 'ESCALATED'],
  NEEDS_REWORK: ['IN_PROGRESS', 'ESCALATED', 'BLOCKED'],
  ESCALATED: [],
};
const requireThat = (condition, message) => {
  if (!condition) throw new Error(message);
};
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const shape = (value, fields, label) => {
  requireThat(
    value && typeof value === 'object' && !Array.isArray(value),
    `${label}: object required`,
  );
  requireThat(
    Object.keys(value).length === fields.split(' ').length &&
      fields.split(' ').every((field) => Object.hasOwn(value, field)),
    `${label}: incorrect fields`,
  );
};
const timestamp = (value, now) => {
  requireThat(
    typeof value === 'string' &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value &&
      Date.parse(value) <= now,
    'canonical non-future UTC timestamp required',
  );
};

export function replayHistory(history, { now = Date.now() } = {}) {
  requireThat(
    Array.isArray(history) && history.length > 0 && history.length <= 500,
    'history: 1..500 events required',
  );
  let previous = null;
  let lastTime = '';
  for (const event of history) {
    shape(event, 'status at actor findings', 'history event');
    timestamp(event.at, now);
    requireThat(event.at >= lastTime && text(event.actor), 'history: ordering and actor required');
    requireThat(
      Array.isArray(event.findings) && event.findings.every(text),
      'history: findings array required',
    );
    requireThat(
      previous === null ? event.status === 'CREATED' : EDGES[previous]?.includes(event.status),
      'history: illegal transition',
    );
    requireThat(
      !['BLOCKED', 'REJECTED', 'FAILED', 'NEEDS_REWORK', 'ESCALATED'].includes(event.status) ||
        event.findings.length > 0,
      'history: failure state requires findings',
    );
    previous = event.status;
    lastTime = event.at;
  }
  return previous;
}

export function transitionTask(task, event, options) {
  requireThat(
    task.status === replayHistory(task.contract.history, options),
    'status differs from replay',
  );
  const history = [...task.contract.history, event];
  const status = replayHistory(history, options);
  return {
    ...task,
    status,
    updatedAt: event.at,
    blockedReason: status === 'BLOCKED' ? event.findings.join('; ') : null,
    contract: { ...task.contract, history },
  };
}

export const RISK_ROLES = {
  R0: ['documentation'],
  R1: ['testing', 'code-review'],
  R2: ['testing', 'code-review', 'performance'],
  R3: ['testing', 'architecture', 'security', 'integration', 'regression', 'code-review'],
  R4: ['testing', 'cto', 'architecture', 'security', 'regression', 'code-review'],
  R5: ['testing', 'cto', 'architecture', 'security', 'regression', 'code-review'],
};
const digestShape = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const revisionShape = (value) =>
  typeof value === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value);
const unique = (values, label) =>
  requireThat(new Set(values).size === values.length, `${label}: duplicate values`);

export function contractInputs(contract) {
  const inputs = { ...contract };
  delete inputs.reviews;
  const { history } = contract;
  let end = history.length;
  while (
    end > 0 &&
    ['REVIEW', 'PASSED', 'COMPLETE'].includes(history[end - 1].status) &&
    history[end - 1].findings.length === 0
  )
    end--;
  return {
    ...inputs,
    history: history.slice(0, end),
    failures: contract.failures.map((failure) => {
      const input = { ...failure };
      delete input.resolvedBy;
      return input;
    }),
  };
}

export function validateBaseline(baseline) {
  shape(baseline, 'schemaVersion failures', 'baseline');
  requireThat(
    baseline.schemaVersion === 1 && Array.isArray(baseline.failures),
    'baseline: unsupported or malformed',
  );
  for (const failure of baseline.failures) {
    shape(failure, 'checkId signature', 'baseline failure');
    requireThat(
      text(failure.checkId) && text(failure.signature),
      'baseline: check ID and signature required',
    );
  }
  unique(
    baseline.failures.map(({ checkId, signature }) => JSON.stringify([checkId, signature])),
    'baseline failures',
  );
  return baseline;
}

export function validateTaskContract(
  task,
  { baseline, agents, now = Date.now(), normalizePath, existingFile },
) {
  const contract = task.contract;
  shape(
    contract,
    'risk baseline forbiddenPaths changedPaths history checks reviews approvalRequired humanApproval failures',
    'contract',
  );
  requireThat(Object.hasOwn(RISK_ROLES, contract.risk), 'contract: invalid risk');
  requireThat(
    task.status === replayHistory(contract.history, { now }),
    'status differs from replay',
  );
  requireThat(
    contract.history[0].at === task.createdAt && contract.history.at(-1).at <= task.updatedAt,
    'history outside task timestamps',
  );
  for (const event of contract.history)
    requireThat(agents.has(event.actor.toLowerCase()), 'history: unknown actor');
  const paths = (values, label) => {
    requireThat(Array.isArray(values), `${label}: array required`);
    const result = values.map((value) => normalizePath(value).toLowerCase());
    unique(result, label);
    return result;
  };
  const allowed = paths(task.files, 'allowed files');
  requireThat(allowed.length > 0, 'allowed files required');
  task.files.forEach(existingFile);
  const forbidden = paths(contract.forbiddenPaths, 'forbidden paths');
  const changed = paths(contract.changedPaths, 'changed paths');
  const contains = (parent, child) => parent === child || child.startsWith(`${parent}/`);
  requireThat(
    !allowed.some((file) => forbidden.some((path) => contains(path, file) || contains(file, path))),
    'allowed/forbidden overlap',
  );
  requireThat(
    changed.every(
      (file) => allowed.includes(file) && !forbidden.some((path) => contains(path, file)),
    ),
    'changed path out-of-scope',
  );
  validateBaseline(baseline);
  requireThat(Array.isArray(contract.checks), 'contract checks required');
  for (const check of contract.checks) {
    shape(check, 'role checkId applicable reason', 'contract check');
    requireThat(
      RISK_ROLES[contract.risk].includes(check.role) &&
        text(check.checkId) &&
        (check.checkId === 'regression' ||
          task.acceptanceCriteria.some(({ id }) => id === check.checkId)),
      'risk: unknown role or check ID',
    );
    requireThat(
      typeof check.applicable === 'boolean' &&
        (check.applicable ? check.reason === null : text(check.reason)),
      'risk: applicability requires reason',
    );
    requireThat(
      check.applicable ||
        (['testing', 'performance'].includes(check.role) && ['R1', 'R2'].includes(contract.risk)),
      'risk: required check cannot be excluded',
    );
  }
  unique(
    contract.checks.map(({ role }) => role),
    'risk roles',
  );
  requireThat(
    RISK_ROLES[contract.risk].every((role) => contract.checks.some((check) => check.role === role)),
    'risk: required role/check missing',
  );
  requireThat(typeof contract.approvalRequired === 'boolean', 'approvalRequired: boolean required');
  if (contract.humanApproval !== null) {
    shape(contract.humanApproval, 'actor approvedAt reason', 'human approval');
    requireThat(
      text(contract.humanApproval.actor) &&
        contract.humanApproval.actor.toLowerCase() !== task.owner.toLowerCase() &&
        text(contract.humanApproval.reason),
      'independent human approval required',
    );
    timestamp(contract.humanApproval.approvedAt, now);
    requireThat(
      contract.humanApproval.approvedAt >= task.createdAt &&
        contract.humanApproval.approvedAt <= task.updatedAt,
      'approval outside task timestamps',
    );
  }
  const approvalNeeded = contract.approvalRequired || contract.risk === 'R5';
  if (approvalNeeded) {
    const firstExecution = contract.history.find(({ status }) => status === 'ASSIGNED');
    requireThat(
      !firstExecution ||
        (contract.humanApproval && contract.humanApproval.approvedAt <= firstExecution.at),
      'human approval required before assignment',
    );
    if (!contract.humanApproval)
      requireThat(task.status === 'BLOCKED', 'unapproved task must be BLOCKED');
  }
  requireThat(Array.isArray(contract.reviews), 'role reviews required');
  for (const review of contract.reviews) {
    shape(review, 'role agent verdict findings revision digest reviewedAt', 'role review');
    requireThat(
      contract.checks.some(({ role }) => role === review.role) &&
        agents.has(review.agent?.toLowerCase()) &&
        review.agent.toLowerCase() !== task.owner.toLowerCase(),
      'role review must be independent and registered',
    );
    requireThat(
      ['APPROVED', 'REJECTED', 'BLOCKED'].includes(review.verdict) &&
        Array.isArray(review.findings) &&
        review.findings.every(text),
      'invalid role review',
    );
    requireThat(
      review.verdict === 'APPROVED' ? review.findings.length === 0 : review.findings.length > 0,
      'review verdict requires consistent findings',
    );
    requireThat(
      revisionShape(review.revision) && digestShape(review.digest),
      'invalid review binding',
    );
    timestamp(review.reviewedAt, now);
    requireThat(
      review.reviewedAt >= task.createdAt &&
        review.reviewedAt <= task.updatedAt &&
        task.evidence.every(({ recordedAt }) => recordedAt <= review.reviewedAt),
      'role review must follow evidence',
    );
  }
  unique(
    contract.reviews.map(({ role }) => role),
    'role reviews',
  );
  if (
    contract.reviews.some(({ verdict }) => verdict !== 'APPROVED') ||
    task.review?.verdict === 'CHANGES_REQUESTED'
  )
    requireThat(
      ['REJECTED', 'BLOCKED', 'NEEDS_REWORK', 'ESCALATED'].includes(task.status),
      'rejected review cannot advance task',
    );
  requireThat(
    Array.isArray(contract.failures) && contract.failures.length <= 4,
    'failures: bounded history required',
  );
  let attempts = 0;
  let previousTime = task.createdAt;
  const strategies = new Set();
  for (const [index, failure] of contract.failures.entries()) {
    shape(
      failure,
      'id checkId command at exitCode result signature classification introducedBy phase attempt strategy nextAction resolvedBy',
      'failure',
    );
    requireThat(
      text(failure.id) &&
        text(failure.command) &&
        text(failure.signature) &&
        text(failure.introducedBy) &&
        text(failure.strategy) &&
        text(failure.nextAction),
      'failure metadata required',
    );
    requireThat(
      failure.checkId === 'regression' ||
        task.acceptanceCriteria.some(({ id }) => id === failure.checkId),
      'failure: unknown check ID',
    );
    timestamp(failure.at, now);
    requireThat(failure.at >= previousTime && failure.at <= task.updatedAt, 'failure ordering');
    previousTime = failure.at;
    requireThat(
      ['FAIL', 'TIMEOUT', 'TRUNCATED', 'ERROR'].includes(failure.result) &&
        ((Number.isSafeInteger(failure.exitCode) && failure.exitCode >= 0) ||
          failure.exitCode === null),
      'failure must record unsuccessful result',
    );
    requireThat(
      ['BASELINE_EXISTING', 'REGRESSION_INTRODUCED', 'UNKNOWN'].includes(failure.classification),
      'failure classification required',
    );
    const known = baseline.failures.some(
      ({ checkId, signature }) => checkId === failure.checkId && signature === failure.signature,
    );
    requireThat(
      failure.classification === 'BASELINE_EXISTING' ? known : !known,
      'failure baseline classification contradicts baseline',
    );
    requireThat(
      index === 0
        ? failure.phase === 'INITIAL' && failure.attempt === 0
        : failure.phase === 'REMEDIATION' && failure.attempt === ++attempts,
      'failure attempt reset or gap',
    );
    const strategy = failure.strategy.trim().toLowerCase();
    requireThat(!strategies.has(strategy), 'repeated remediation strategy');
    strategies.add(strategy);
    requireThat(
      failure.resolvedBy === null || text(failure.resolvedBy),
      'failure resolvedBy must be evidence ID or null',
    );
    if (failure.resolvedBy !== null)
      requireThat(
        task.evidence.some(
          (item) =>
            item.id === failure.resolvedBy &&
            item.check === failure.checkId &&
            item.command === failure.command &&
            item.result === 'PASS' &&
            item.recordedAt >= failure.at,
        ),
        'failure requires linked successful rerun',
      );
  }
  unique(
    contract.failures.map(({ id }) => id),
    'failure IDs',
  );
  requireThat(
    task.attemptLimit === 3 && task.attempts === attempts,
    'v2 attempts must equal retained REMEDIATION failures (limit 3)',
  );
  if (attempts === 3 && contract.failures.some(({ resolvedBy }) => resolvedBy === null))
    requireThat(task.status === 'ESCALATED', 'exhausted remediation requires escalation');
  for (const item of task.evidence.filter(({ result }) => result === 'FAIL'))
    requireThat(
      contract.failures.some(
        (failure) =>
          failure.id === item.id &&
          failure.checkId === item.check &&
          failure.command === item.command &&
          failure.at === item.recordedAt,
      ),
      'failed evidence requires retained failure record',
    );
}

export function successfulEvidence(evidence, failures) {
  return evidence.filter(
    (item) =>
      item.result === 'PASS' ||
      !failures.some((failure) => failure.id === item.id && failure.resolvedBy !== null),
  );
}

export function proveTaskContract(task, { revision, digest }) {
  const contract = task.contract;
  requireThat(
    contract.failures.every(({ resolvedBy }) => resolvedBy !== null),
    'unresolved failures prevent passage',
  );
  for (const failure of contract.failures)
    requireThat(
      task.evidence.some(
        (item) =>
          item.id === failure.resolvedBy &&
          item.result === 'PASS' &&
          item.digest === digest &&
          item.revision === revision,
      ),
      'resolved failure needs current rerun',
    );
  for (const check of contract.checks) {
    requireThat(
      contract.reviews.some(
        (review) =>
          review.role === check.role &&
          review.verdict === 'APPROVED' &&
          review.revision === revision &&
          review.digest === digest,
      ),
      'risk: current independent role approval required',
    );
    if (check.applicable)
      requireThat(
        task.evidence.some(
          (item) =>
            item.check === check.checkId &&
            item.result === 'PASS' &&
            item.revision === revision &&
            item.digest === digest,
        ),
        'risk: successful required check missing',
      );
  }
  requireThat(
    task.review &&
      task.review.reviewedAt >= contract.history.findLast(({ status }) => status === 'REVIEW').at &&
      task.review.reviewedAt <= contract.history.findLast(({ status }) => status === 'PASSED').at &&
      contract.reviews.every(({ reviewedAt }) => reviewedAt <= task.review.reviewedAt),
    'final approval must follow REVIEW and role reviews and precede PASSED',
  );
}
