// Shared by check-traceability.mjs and check-requirements-inventory.mjs so both decide the same way
// which workflow steps run on push or pull_request. A step that only a manual dispatch can reach is
// not CI-run evidence for either checker.

/**
 * True when an `if` expression can only be satisfied by a manual dispatch: it requires
 * `github.event_name == 'workflow_dispatch'` and names no other event and no negated dispatch test.
 * An expression that is absent, or that also admits push, pull_request or schedule, is not dispatch-only.
 */
export function isDispatchOnly(condition) {
  if (typeof condition !== 'string') return false;
  return (
    /==\s*'workflow_dispatch'/.test(condition) &&
    !/!=\s*'workflow_dispatch'/.test(condition) &&
    !/==\s*'(?:push|pull_request|pull_request_target|schedule)'/.test(condition)
  );
}

/** Every object that has a `steps` array (a job), wherever it sits in the parsed workflow. */
function jobsOf(node, found = []) {
  if (Array.isArray(node)) for (const item of node) jobsOf(item, found);
  else if (node && typeof node === 'object') {
    if (Array.isArray(node.steps)) found.push(node);
    for (const value of Object.values(node)) jobsOf(value, found);
  }
  return found;
}

/**
 * The `run` commands of one parsed workflow that execute on push or pull_request. A step whose own
 * `if` is dispatch-only, or that sits in a job whose `if` is dispatch-only, is left out.
 */
export function runCommandsOf(document) {
  const commands = [];
  for (const job of jobsOf(document)) {
    if (isDispatchOnly(job.if)) continue;
    for (const step of job.steps)
      if (step && typeof step.run === 'string' && !isDispatchOnly(step.if)) commands.push(step.run);
  }
  return commands;
}
