/**
 * Validates the Stage 01 file-level audit manifest (docs/audits/STAGE-01-FILE-AUDIT.json) against the
 * tracked files in Git. It checks completeness and record integrity only. It cannot prove that a human or
 * agent actually read a file, so a `reviewed` state is an attestation that the record must back with
 * observations, a reviewer and the content hash of the file at review time.
 *
 * Usage:
 *   node scripts/ci/check-file-audit.mjs            validate integrity and report coverage
 *   node scripts/ci/check-file-audit.mjs --sync     add tracked files missing from the manifest (not-reviewed)
 *                                                    and drop entries for files that are no longer tracked
 *   node scripts/ci/check-file-audit.mjs --require-complete
 *                                                   also fail while any file is not reviewed
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const manifestPath = resolve(root, 'docs/audits/STAGE-01-FILE-AUDIT.json');

const states = new Set([
  'reviewed',
  'partially-reviewed',
  'not-reviewed',
  'requires-investigation',
  'not-applicable-source',
]);
const severities = new Set(['critical', 'high', 'medium', 'low', 'info']);
const findingStatuses = new Set(['open', 'fixed', 'accepted-risk', 'no-action']);
const binaryExtensions = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.pdf',
  '.zip',
]);
const generatedPatterns = [/(^|\/)package-lock\.json$/, /^migrations\/meta\//];

export function classify(path) {
  if (generatedPatterns.some((pattern) => pattern.test(path))) {
    return { category: 'generated-lockfile-or-snapshot', state: 'not-applicable-source' };
  }
  if (binaryExtensions.has(extname(path).toLowerCase())) {
    return { category: 'binary-asset', state: 'not-applicable-source' };
  }
  if (path.startsWith('docs/audits/STAGE-01-FILE-AUDIT.')) {
    return { category: 'self-referential-audit-record', state: 'not-applicable-source' };
  }
  if (extname(path) === '.md' || path.startsWith('docs/'))
    return { category: 'documentation', state: 'not-reviewed' };
  if (path.startsWith('.github/'))
    return { category: 'github-actions-or-governance', state: 'not-reviewed' };
  if (path.startsWith('apps/web/')) return { category: 'frontend', state: 'not-reviewed' };
  if (path.startsWith('apps/api/')) return { category: 'backend-api', state: 'not-reviewed' };
  if (path.startsWith('apps/workers/'))
    return { category: 'background-workers', state: 'not-reviewed' };
  if (path.startsWith('packages/'))
    return { category: 'shared-domain-package', state: 'not-reviewed' };
  if (path.startsWith('migrations/'))
    return { category: 'database-migration', state: 'not-reviewed' };
  if (path.startsWith('infra/'))
    return { category: 'deployment-infrastructure', state: 'not-reviewed' };
  if (path.startsWith('scripts/')) return { category: 'tooling-and-tests', state: 'not-reviewed' };
  if (path.startsWith('tests/')) return { category: 'tests', state: 'not-reviewed' };
  return { category: 'repository-configuration', state: 'not-reviewed' };
}

export function sha256Of(path) {
  return createHash('sha256')
    .update(readFileSync(resolve(root, path)))
    .digest('hex');
}

export function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .sort();
}

/** Returns a list of integrity problems. An empty list means the manifest matches the repository. */
export function validate(manifest, tracked, { requireComplete = false } = {}) {
  const errors = [];
  if (manifest.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (!Array.isArray(manifest.files)) return ['files must be an array'];

  const seen = new Map();
  for (const entry of manifest.files) {
    if (typeof entry.path !== 'string' || entry.path.length === 0) {
      errors.push('an entry has no path');
      continue;
    }
    if (seen.has(entry.path)) errors.push(`duplicate entry: ${entry.path}`);
    seen.set(entry.path, entry);
    if (!states.has(entry.state)) errors.push(`${entry.path}: invalid state "${entry.state}"`);
    if (typeof entry.category !== 'string' || entry.category.length === 0)
      errors.push(`${entry.path}: category is required`);
    if (typeof entry.reviewMethod !== 'string' || entry.reviewMethod.length === 0)
      errors.push(`${entry.path}: reviewMethod is required`);
    if (!Array.isArray(entry.findings)) errors.push(`${entry.path}: findings must be an array`);

    for (const finding of entry.findings ?? []) {
      if (!severities.has(finding.severity))
        errors.push(`${entry.path}: ${finding.id} has invalid severity`);
      if (!findingStatuses.has(finding.status))
        errors.push(`${entry.path}: ${finding.id} has invalid status`);
      if (typeof finding.summary !== 'string' || finding.summary.length === 0)
        errors.push(`${entry.path}: ${finding.id} needs a summary`);
      if (finding.status === 'fixed' && !finding.remediation)
        errors.push(`${entry.path}: ${finding.id} is fixed but has no remediation reference`);
    }

    if (entry.state === 'reviewed') {
      if (!entry.reviewer) errors.push(`${entry.path}: reviewed without a reviewer`);
      if (!entry.observations) errors.push(`${entry.path}: reviewed without observations`);
      if (!entry.sha256) errors.push(`${entry.path}: reviewed without a content hash`);
      else if (existsSync(resolve(root, entry.path)) && entry.sha256 !== sha256Of(entry.path))
        errors.push(`${entry.path}: content changed since review (stale record)`);
    }
    if (entry.state === 'not-applicable-source' && !entry.observations)
      errors.push(`${entry.path}: not-applicable-source needs a stated reason`);
  }

  for (const path of tracked) {
    if (!seen.has(path)) errors.push(`tracked file missing from manifest: ${path}`);
  }
  for (const path of seen.keys()) {
    if (!tracked.includes(path)) errors.push(`manifest lists a file that is not tracked: ${path}`);
  }

  if (requireComplete) {
    for (const entry of manifest.files) {
      if (
        entry.state === 'not-reviewed' ||
        entry.state === 'partially-reviewed' ||
        entry.state === 'requires-investigation'
      )
        errors.push(`${entry.path}: still ${entry.state}`);
    }
  }

  for (const entry of manifest.files) {
    for (const finding of entry.findings ?? []) {
      if (
        (finding.severity === 'critical' || finding.severity === 'high') &&
        finding.status === 'open'
      )
        errors.push(`${entry.path}: unresolved ${finding.severity} finding ${finding.id}`);
    }
  }
  return errors;
}

export function summarize(manifest, tracked) {
  const counts = {};
  for (const entry of manifest.files) counts[entry.state] = (counts[entry.state] ?? 0) + 1;
  const findings = { open: 0, fixed: 0, 'accepted-risk': 0, 'no-action': 0 };
  for (const entry of manifest.files)
    for (const finding of entry.findings ?? []) findings[finding.status] += 1;
  return { trackedFiles: tracked.length, states: counts, findings };
}

/** Adds missing tracked files and removes entries for files that are gone. Existing records are kept. */
export function sync(manifest, tracked) {
  const existing = new Map(manifest.files.map((entry) => [entry.path, entry]));
  const files = tracked.map((path) => {
    const entry = existing.get(path);
    if (entry) return entry;
    const { category, state } = classify(path);
    const reason =
      state === 'not-applicable-source'
        ? category === 'binary-asset'
          ? 'Binary asset: reviewed by path, type and reference only, not as source text.'
          : 'Generated file: its integrity is covered by the package manager or migration tooling and it is not hand-written source.'
        : undefined;
    return {
      path,
      category,
      reviewMethod: state === 'not-applicable-source' ? 'classification-only' : 'none',
      state,
      concerns: [],
      findings: [],
      observations: reason ?? '',
      evidence: '',
      reviewer: '',
      sha256: '',
    };
  });
  return { ...manifest, files };
}

function main() {
  const args = new Set(process.argv.slice(2));
  const tracked = trackedFiles();
  if (!existsSync(manifestPath)) {
    console.error(`Missing ${manifestPath}. Run with --sync to create it.`);
    process.exitCode = 1;
    return;
  }
  let manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (args.has('--sync')) {
    manifest = sync(manifest, tracked);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Synced manifest: ${manifest.files.length} entries.`);
  }
  const errors = validate(manifest, tracked, { requireComplete: args.has('--require-complete') });
  const summary = summarize(manifest, tracked);
  console.log(JSON.stringify(summary, null, 2));
  if (errors.length > 0) {
    console.error(`File audit check failed with ${errors.length} problem(s):`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log('File audit manifest matches the tracked files and its records are valid.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
