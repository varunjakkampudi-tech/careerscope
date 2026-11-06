#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { ciExecutedText, workflowRunText } from './check-traceability.mjs';

export const INVENTORY = 'docs/requirements/OWNER-ROADMAP-TRACEABILITY.json';
const EXPECTED_COUNTS = [
  15, 14, 16, 12, 15, 13, 16, 12, 14, 15, 14, 17, 16, 10, 13, 18, 20, 15, 20, 14, 14, 15,
];
const SOURCE_SHA256 = '427aa3fd646d1b27c535d6765411bda924755d1dfc8dae14980d73d03b056045';
const STATUSES = new Set(['verified', 'in-progress', 'partial', 'gated', 'not-started']);

export function checkRoadmap(root = process.cwd()) {
  const errors = [];
  let inventory;
  try {
    inventory = JSON.parse(readFileSync(join(root, INVENTORY), 'utf8'));
  } catch (error) {
    return { errors: [`cannot read ${INVENTORY}: ${error.message}`] };
  }
  const items = inventory.items;
  if (inventory.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (!Array.isArray(items)) return { errors: [...errors, 'items must be an array'] };
  if (inventory.itemCount !== 328 || items.length !== 328)
    errors.push('roadmap must contain exactly 328 items');
  if (inventory.stageCount !== 22 || Object.keys(inventory.stageItemCounts ?? {}).length !== 22)
    errors.push('roadmap must contain exactly 22 stages');
  for (let stage = 1; stage <= 22; stage++) {
    if (inventory.stageItemCounts?.[stage] !== EXPECTED_COUNTS[stage - 1])
      errors.push(`stage ${stage} must contain ${EXPECTED_COUNTS[stage - 1]} items`);
  }
  if (inventory.source?.sha256 !== SOURCE_SHA256)
    errors.push('source.sha256 does not match the pinned owner roadmap');
  for (const excluded of ['Hostinger hosting', 'server backups', 'production deployment']) {
    if (!inventory.scopeExclusions?.includes(excluded))
      errors.push(`scopeExclusions must include ${excluded}`);
  }

  const manifestText = ciExecutedText(root) + '\n' + workflowRunText(root);
  const seen = new Set();
  const expectedIds = EXPECTED_COUNTS.flatMap((count, index) =>
    Array.from(
      { length: count },
      (_, itemIndex) => `${index + 1}.${String(itemIndex + 1).padStart(2, '0')}`,
    ),
  );
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const expectedId = expectedIds[index];
    const expectedStage = Number(expectedId?.split('.')[0]);
    const prefix = `${item.id ?? `item ${index + 1}`}:`;
    if (item.id !== expectedId) errors.push(`${prefix} expected sequential ID ${expectedId}`);
    if (item.stage !== expectedStage)
      errors.push(`${prefix} stage does not match its checklist ID`);
    if (seen.has(item.id)) errors.push(`${prefix} duplicate ID`);
    seen.add(item.id);
    if (!Number.isInteger(item.stage) || item.stage < 1 || item.stage > 22)
      errors.push(`${prefix} invalid stage`);
    for (const field of ['stageTitle', 'title', 'sourceStatus', 'gap']) {
      if (typeof item[field] !== 'string' || (field !== 'gap' && !item[field].trim()))
        errors.push(`${prefix} ${field} must be a non-empty string`);
    }
    if (!STATUSES.has(item.currentStatus)) errors.push(`${prefix} invalid currentStatus`);
    if (!Array.isArray(item.evidence) || !item.evidence.length)
      errors.push(`${prefix} evidence must name at least one path`);
    if (!Array.isArray(item.tests)) errors.push(`${prefix} tests must be an array`);
    if (!Array.isArray(item.externalEvidence))
      errors.push(`${prefix} externalEvidence must be an array`);
    const evidencePaths = Array.isArray(item.evidence) ? item.evidence : [];
    const testPaths = Array.isArray(item.tests) ? item.tests : [];
    const externalEvidence = Array.isArray(item.externalEvidence) ? item.externalEvidence : [];
    for (const path of [...evidencePaths, ...testPaths]) {
      if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('..')) {
        errors.push(`${prefix} invalid repository-relative path: ${path}`);
      } else if (!existsSync(join(root, path))) {
        errors.push(`${prefix} referenced file not found: ${path}`);
      }
    }
    for (const path of testPaths) {
      if (typeof path !== 'string') continue;
      if (!/(?:\.test\.[cm]?[jt]sx?$)|^(?:scripts\/tests|tests)\//.test(path))
        errors.push(`${prefix} test path is not a test file: ${path}`);
      else if (!manifestText.includes(path))
        errors.push(`${prefix} test is not run by CI: ${path}`);
    }
    if (externalEvidence.some((entry) => typeof entry !== 'string' || !entry.trim()))
      errors.push(`${prefix} externalEvidence entries must be non-empty strings`);
    if (item.currentStatus === 'verified' && !(testPaths.length || externalEvidence.length))
      errors.push(`${prefix} status requires test or external evidence`);
    if (
      ['not-started', 'gated', 'in-progress', 'partial'].includes(item.currentStatus) &&
      (typeof item.gap !== 'string' || !item.gap.trim())
    )
      errors.push(`${prefix} status requires a gap`);
    if (item.currentStatus === 'verified' && typeof item.gap === 'string' && item.gap.trim())
      errors.push(`${prefix} verified status must not carry an open gap`);
    if (!['in-scope', 'excluded'].includes(item.scopeDisposition))
      errors.push(`${prefix} invalid scopeDisposition`);
  }
  return { errors, items: items.length, stages: inventory.stageCount };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = checkRoadmap();
  if (result.errors.length) {
    console.error(result.errors.map((error) => `FAIL ${error}`).join('\n'));
    process.exitCode = 1;
  } else {
    console.log(
      `PASS owner roadmap traceability: ${result.items} items across ${result.stages} stages`,
    );
  }
}
