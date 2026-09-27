#!/usr/bin/env node
// Fails if a file that must be LF contains a CR byte in the working tree.
//
// .gitattributes governs what Git stores; it does not govern what a tool on
// this machine reads a moment after writing it. The defect this guards against
// was exactly that gap: a CRLF file made a multiline regex match nothing, and
// the validator reported "No entries yet" for a file holding three entries.
//
// CS-65: the list of what counts as an LF-only file used to be a literal regex
// here, maintained by hand alongside the patterns in .gitattributes. Two
// independent lists of "what is a text file" is one list too many, and they
// duly diverged: `*.txt text eol=lf` was added to .gitattributes for
// `review.txt` — an append-only audit log parsed in nine places — while this
// file went on skipping `.txt` entirely. The attribute existed and nothing
// checked it.
//
// So the list is no longer duplicated. It is derived from .gitattributes, and
// every `eol=lf` pattern declared there is enforced here by construction. A
// future extension added to one is enforced by the other in the same commit,
// with no second edit to remember.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Anchor every path to the repository root, never to the working directory.
 *
 * Both inputs here are cwd-relative by default: `.gitattributes` and
 * `git ls-files`. Run from a subdirectory, `git ls-files` lists only that
 * subtree — and git supports per-directory `.gitattributes`, so a future one
 * would be read happily alongside a partial file list. That combination
 * reports "no CR bytes" over a fraction of the repository and looks exactly
 * like a pass. There is only one `.gitattributes` today, so this is latent
 * rather than live, which is the right time to close it.
 */
function repositoryRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch (error) {
    console.error(
      `::error::Could not locate the repository root (${error.message}). Refusing to check a directory that may not be the repository.`,
    );
    process.exit(1);
  }
}

const root = repositoryRoot();

/**
 * Every pattern .gitattributes marks `eol=lf`, as a basename/path matcher.
 *
 * Reading zero patterns is a hard failure, never an empty rule set: a check
 * that enforces nothing because it could not read its own configuration would
 * report PASS over the entire repository.
 */
function lfOnlyMatchers() {
  let attributes;
  try {
    attributes = readFileSync(join(root, '.gitattributes'), 'utf8');
  } catch (error) {
    console.error(
      `::error::Could not read .gitattributes (${error.message}). Refusing to enforce an empty rule set.`,
    );
    process.exit(1);
  }

  const matchers = [];
  const unrepresentable = [];
  for (const line of attributes.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const declaration = /^(\S+)\s+(.*)$/.exec(trimmed);
    if (!declaration) continue;
    const [, pattern, rest] = declaration;
    if (!/\beol=lf\b/.test(rest)) continue;

    const basename = (file) => file.slice(file.lastIndexOf('/') + 1);
    if (pattern.startsWith('*.') && !pattern.slice(2).includes('*') && !pattern.includes('/')) {
      const suffix = pattern.slice(1).toLowerCase(); // "*.md" -> ".md"
      matchers.push({ pattern, test: (file) => file.toLowerCase().endsWith(suffix) });
    } else if (pattern.endsWith('.*') && !pattern.includes('/')) {
      const prefix = pattern.slice(0, -1); // "Dockerfile.*" -> "Dockerfile."
      matchers.push({ pattern, test: (file) => basename(file).startsWith(prefix) });
    } else if (!pattern.includes('*') && !pattern.includes('/')) {
      matchers.push({ pattern, test: (file) => basename(file) === pattern });
    } else {
      // L-3: there was no else. A pattern this parser cannot represent —
      // `docs/**/*.md`, `*.[ch]`, or any path-scoped form — contributed no
      // matcher and no warning, so the derivation was silently partial with
      // only the `< 10` floor as a backstop. Worse, a path-scoped bare name
      // such as `.ai/review.txt` would have been compared against the basename
      // and never matched. For a file whose whole point is "derived, not
      // duplicated", a pattern form it cannot express must be loud.
      unrepresentable.push(pattern);
    }
  }

  if (unrepresentable.length > 0) {
    console.error(
      `::error::${unrepresentable.length} eol=lf pattern(s) in .gitattributes are forms this check ` +
        `cannot represent: ${unrepresentable.join(', ')}.\n` +
        'They would be declared but unenforced. Teach this parser the form rather than leaving a ' +
        'silently partial derivation.',
    );
    process.exit(1);
  }

  if (matchers.length < 10) {
    console.error(
      `::error::Only ${matchers.length} eol=lf pattern(s) parsed out of .gitattributes. ` +
        'That is too few to be the real configuration, so this check cannot look and must not pass.',
    );
    process.exit(1);
  }
  return matchers;
}

const matchers = lfOnlyMatchers();
const isLfOnly = (file) => matchers.some((matcher) => matcher.test(file));

// The canonical state files are called out separately: these are the ones read
// by gates, and a silent parse difference here changes a release decision.
//
// `review.txt` is named explicitly because it is the counter-example to a
// directory-shaped rule: it sits at the repository root, not under .ai/ or
// scripts/, yet it is parsed in nine places across check-agents.mjs,
// control-center.mjs, check-customizations.mjs, backup-session.mjs and
// engineering-hook.test.mjs. It is also append-only, which makes it the worst
// possible place for a parser to silently see nothing.
const CRITICAL = /^(\.ai\/|\.github\/(agents|workflows)\/|scripts\/|review\.txt$)/;

let tracked;
try {
  tracked = execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean);
} catch (error) {
  // Being unable to list files is not "no offenders".
  console.error(`::error::Could not list tracked files: ${error.message}`);
  process.exit(1);
}

// A short list is the other way of being unable to look, and it has no error
// message attached: `git ls-files` succeeds and simply returns less. The
// declarations above are checked for plausibility; the file list must be too.
if (tracked.length < 100) {
  console.error(
    `::error::Only ${tracked.length} tracked file(s) found under ${root}. That is too few to be this ` +
      'repository, so this check could not look and must not report a pass.',
  );
  process.exit(1);
}

const offenders = [];
for (const file of tracked) {
  if (!isLfOnly(file)) continue;
  let buffer;
  try {
    buffer = readFileSync(join(root, file));
  } catch (error) {
    if (error.code === 'ENOENT') continue; // deleted but still indexed
    console.error(`::error::Could not read ${file}: ${error.message}`);
    process.exit(1);
  }
  if (buffer.includes(0x0d)) {
    offenders.push({ file, critical: CRITICAL.test(file) });
  }
}

// ---------------------------------------------------------------------------
// Second direction: is the declaration COMPLETE?
//
// The check above derives its universe from .gitattributes, which makes it
// excellent at "does every declared file comply?" and structurally incapable of
// answering "is every text file declared?". A file with no attribute does not
// merely go unchecked — it cannot enter the universe at all, so that gate can
// never turn red for a missing declaration no matter how many are added.
//
// That is the exact shape behind this project's UAT demotions: a green gate
// standing in for a criterion it does not measure. It is harder to spot here,
// not easier, because the first direction is well guarded and reports a
// confident 663/663.
//
// So the population for this half comes from `git ls-files`, not from
// .gitattributes, and the question is inverted. Neither half can substitute for
// the other; only the pair enforces "every tracked text file has an explicit
// eol attribute". They live in one script so they cannot drift apart — which is
// the same mistake, one level up, that put `txt` in .gitattributes and not in
// this file.

/** Binary by git's own heuristic: a NUL byte near the start. */
function classify(file) {
  let buffer;
  try {
    buffer = readFileSync(join(root, file));
  } catch (error) {
    // Unclassifiable is reported, never silently treated as binary and skipped.
    // Skipping is how this half would quietly become decorative.
    return { kind: 'unknown', reason: error.code ?? error.message };
  }
  return { kind: buffer.subarray(0, 8000).includes(0x00) ? 'binary' : 'text' };
}

let attributes;
try {
  attributes = execFileSync('git', ['check-attr', '--stdin', '-z', 'eol'], {
    cwd: root,
    input: tracked.join('\0'),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (error) {
  console.error(`::error::Could not read eol attributes: ${error.message}`);
  process.exit(1);
}

// `-z` output is a flat NUL-separated stream of (path, attribute, value).
const fields = attributes.split('\0');
const undeclared = [];
const unclassifiable = [];
const unexpectedDeclaration = [];
// L-2: the binary count is reported, not merely used. A text file with an
// accidental NUL in its first 8000 bytes — a truncated write, an embedded
// fixture, a UTF-16 save — is classified binary and leaves the completeness
// universe silently. Printing the split makes that movement visible: today
// this repository has exactly four binaries, all PNGs under design/concepts,
// so any change in the number is meaningful rather than noise. In a repository
// with four hundred images this line would be useless; here it is cheap and
// informative, which is why it is worth having.
//
// Counted through `classify()` — the same path the completeness check uses.
// A second implementation of "what is binary" would be this file's own defect,
// reintroduced in its reporting line.
const census = { binary: 0, declared: 0, undeclaredText: 0 };
let examined = 0;
for (let index = 0; index + 2 < fields.length; index += 3) {
  const [file, , value] = [fields[index], fields[index + 1], fields[index + 2]];
  examined += 1;
  if (value === 'unspecified') {
    const { kind, reason } = classify(file);
    if (kind === 'text') {
      undeclared.push(file);
      census.undeclaredText += 1;
    } else if (kind === 'unknown') unclassifiable.push({ file, reason });
    else census.binary += 1;
    continue;
  }
  // L-1: `if (value !== 'unspecified') continue` let ANY declared value satisfy
  // this direction, while the first direction only builds matchers from
  // `eol=lf`. A file declared `text eol=crlf` was therefore checked by neither
  // half — and declaring `eol=crlf` was a valid way to silence a completeness
  // failure, which is the same self-service exemption shape as a limitation
  // being relabelled DEFERRED. This repository's policy is LF everywhere, so
  // anything else is unexpected and says so.
  if (value !== 'lf') unexpectedDeclaration.push({ file, value });
  else census.declared += 1;
}

if (unexpectedDeclaration.length > 0) {
  for (const { file, value } of unexpectedDeclaration) {
    console.error(`  UNEXPECTED eol=${value}  ${file}`);
  }
  console.error(
    `\n::error::${unexpectedDeclaration.length} tracked file(s) declare an eol attribute other than ` +
      '`lf`. This repository normalises everything to LF, and a non-lf declaration is checked by ' +
      'neither half of this script — so it would silence the completeness check without being ' +
      'subject to the compliance one. Declare `eol=lf`, or teach this check the new policy deliberately.',
  );
  process.exit(1);
}

if (examined !== tracked.length) {
  console.error(
    `::error::Asked about ${tracked.length} tracked file(s) but git answered for ${examined}. ` +
      'Refusing to report complete coverage from a partial answer.',
  );
  process.exit(1);
}

if (unclassifiable.length > 0) {
  for (const { file, reason } of unclassifiable) {
    console.error(`  UNCLASSIFIABLE  ${file}  (${reason})`);
  }
  console.error(
    `\n::error::${unclassifiable.length} tracked file(s) could not be classified as text or binary. ` +
      'An unreadable file is not a binary file; resolve these rather than assuming they need no attribute.',
  );
  process.exit(1);
}

if (undeclared.length > 0) {
  for (const file of undeclared) console.error(`  NO eol ATTRIBUTE  ${file}`);
  console.error(
    `\n::error::${undeclared.length} tracked text file(s) have no explicit eol attribute, so nothing ` +
      'governs their line endings on checkout and the compliance check above cannot see them at all.\n' +
      'Declare them in .gitattributes (for example `*.sql text eol=lf`), then run `git add --renormalize .`.',
  );
  process.exit(1);
}

if (offenders.length === 0) {
  console.log(
    `PASS  no CR bytes in ${tracked.filter(isLfOnly).length} LF-only files ` +
      `(${matchers.length} eol=lf patterns from .gitattributes), and all ` +
      `${tracked.length} tracked files are either binary or carry an explicit eol attribute\n` +
      `      tracked ${tracked.length} = declared ${census.declared} + binary ${census.binary}` +
      `${census.undeclaredText ? ` + undeclared text ${census.undeclaredText}` : ''}` +
      `${unclassifiable.length ? ` + unclassifiable ${unclassifiable.length}` : ''}`,
  );
  process.exit(0);
}

const critical = offenders.filter((o) => o.critical);
for (const { file, critical: isCritical } of offenders) {
  console.error(`  CRLF  ${file}${isCritical ? '  (read by a gate)' : ''}`);
}
console.error(
  `\n::error::${offenders.length} file(s) contain CR bytes where LF is required` +
    `${critical.length ? `, ${critical.length} of them read by a gate` : ''}.` +
    ` Fix with: git add --renormalize .`,
);
process.exit(1);
