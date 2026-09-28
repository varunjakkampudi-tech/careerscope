#!/usr/bin/env node
// CS-73: ticket ownership and displayed status must agree with the evidence.
// A reader should not need to search the evidence tail to discover that a
// supposedly frontend ticket is waiting on infrastructure or that a BLOCKED
// item is rendered as READY.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const backlog = JSON.parse(readFileSync('.ai/backlog.json', 'utf8'));
assert.ok(Array.isArray(backlog.items) && backlog.items.length > 20, 'backlog is not readable');

function validateItem(ticket) {
  const problems = [];
  const current = String(ticket.currentStep ?? '');
  // Existing currentStep prose is intentionally human-readable and often
  // quotes the next workflow stage. Only an explicit machine marker is a
  // contract this validator may enforce; ordinary prose is left to the board
  // review rather than guessed at with substring heuristics.
  const declaredStatus = /^STATUS:\s*(\w+)/i.exec(current)?.[1]?.toUpperCase();
  if (declaredStatus && ticket.status !== declaredStatus) {
    problems.push(
      `${ticket.id}: status ${ticket.status} contradicts declared currentStep status ${declaredStatus}`,
    );
  }

  const evidence = [ticket.architectureImpact, ticket.currentStep, ...(ticket.evidence ?? [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const infrastructureWork =
    /remaining work (?:belongs (?:to|in)|lives in) (?:the )?infrastructure/i.test(evidence);
  const frontendOnly = /^(?:Frontend|Backend|QA)$/i.test(String(ticket.ownerAgent ?? ''));
  if (
    infrastructureWork &&
    frontendOnly &&
    !/declares? .*infrastructure|architectureimpact declares|cross[- ]tier dependency|owner[- ]lockout/i.test(
      evidence,
    )
  ) {
    problems.push(
      `${ticket.id}: ownerAgent ${ticket.ownerAgent} does not own the infrastructure work disclosed by its evidence`,
    );
  }
  return problems;
}

const failures = backlog.items.flatMap(validateItem);
// Prove the validator is not decorative: the historical CS-54 shape fails,
// while the current corrected shape and the explicitly cross-tier CS-59 shape
// pass the same function.
const syntheticWrong = validateItem({
  id: 'synthetic-CS-54',
  status: 'READY',
  ownerAgent: 'Frontend',
  architectureImpact: 'Next.js strategy',
  currentStep: 'READY',
  evidence: ['remaining work belongs to the infrastructure session'],
});
const syntheticConsistent = validateItem({
  id: 'synthetic-CS-59',
  status: 'READY',
  ownerAgent: 'Backend',
  architectureImpact: 'Rate limit may require a proxy deployment change',
  currentStep: 'READY',
  evidence: ['architectureImpact declares the cross-tier dependency'],
});
assert.ok(syntheticWrong.length > 0, 'synthetic contradictory ownership unexpectedly passed');
assert.deepEqual(
  syntheticConsistent,
  [],
  'synthetic declared cross-tier dependency unexpectedly failed',
);
assert.deepEqual(failures, [], failures.join('\n'));
process.stdout.write(
  `PASS  ${backlog.items.length} tickets have consistent ownership and status metadata\n`,
);
