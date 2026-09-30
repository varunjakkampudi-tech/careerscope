// Answers one question honestly: "does anything in .github/workflows actually
// execute this file?"
//
// This exists because the repository has repeatedly confused four different
// states — a check being *implemented*, *wired* into an npm script, *executed*
// in CI, and *verified* against a live host. A script that exists and is named
// by an npm script nobody runs is not coverage, but it reads exactly like
// coverage to anyone grepping for its name.
//
// Resolution is deliberately over-approximating in one direction only: if this
// module says a file is unreachable, nothing runs it. It may occasionally call
// something reachable that is only conditionally reached (a `workflow_dispatch`
// job, say) — which is why callers get the workflow names back and can insist
// on a push-triggered one.
//
// Parsed with a small line reader rather than a YAML library on purpose. The
// only YAML parser installed here is a transitive dependency of something else;
// depending on it would make this check's survival contingent on an unrelated
// package's dependency tree, and this check exists precisely to stop silent
// loss of coverage.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

/** Anything a workflow step could be. */
export class CommandSource {
  constructor(workflow, text) {
    this.workflow = workflow;
    this.text = text;
  }
}

function normalize(path) {
  return path.split(sep).join('/');
}

/**
 * Reads every step body out of a workflow, keeping the `working-directory` that
 * was in force for it, because `npm run build` means a different script in `v2`
 * than it does at the repository root.
 */
function readWorkflow(file) {
  const raw = readFileSync(file, 'utf8');
  const lines = raw.split(/\r?\n/);
  const steps = [];
  let workingDirectory = '.';
  let jobWorkingDirectory = '.';
  let collecting = null;

  const flush = () => {
    if (collecting && collecting.body.length > 0) {
      steps.push({
        workingDirectory: collecting.workingDirectory,
        text: collecting.body.join('\n'),
      });
    }
    collecting = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (collecting) {
      const indent = /^(\s*)/.exec(line)[1].length;
      if (line.trim() === '' || indent > collecting.indent) {
        // F-52-3: shell comments inside a `run: |` block are not execution.
        // This module's entire job is telling real execution apart from
        // apparent execution, and the comments in these workflows quote the
        // exact paths somebody would grep for — so a path mentioned only in a
        // `#` line must not count as run. Only whole-line comments are dropped:
        // a trailing `#` cannot be removed safely, because `${name#prefix}` and
        // a URL fragment both contain one and neither is a comment.
        if (!line.trim().startsWith('#')) collecting.body.push(line.trim());
        continue;
      }
      flush();
    }

    // A new list item resets any step-scoped working directory.
    if (/^\s*-\s/.test(line)) workingDirectory = jobWorkingDirectory;

    const defaults = /^\s*working-directory:\s*(\S+)\s*$/.exec(line);
    if (defaults) {
      workingDirectory = defaults[1].replaceAll(/['"]/g, '');
      // `defaults.run.working-directory` sits at a shallower indent than a
      // step's own, and applies to every step in the job.
      if (/^ {8}working-directory:/.test(line)) jobWorkingDirectory = workingDirectory;
      continue;
    }

    const run = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(line);
    if (run) {
      const indent = /^(\s*)/.exec(line)[1].length;
      const inline = run[2].trim();
      if (inline !== '' && inline !== '|' && inline !== '>' && inline !== '|-' && inline !== '>-') {
        steps.push({ workingDirectory, text: inline });
      } else {
        collecting = { indent, workingDirectory, body: [] };
      }
    }
  }
  flush();
  return steps;
}

function manifestFor(root, directory) {
  const file = join(root, directory, 'package.json');
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  // A manifest that exists but does not parse is a hard failure, never an
  // empty script list: "could not read" must never be reported as "nothing
  // here".
  const parsed = JSON.parse(raw);
  return {
    directory: normalize(directory) === '' ? '.' : normalize(directory),
    scripts: parsed.scripts ?? {},
  };
}

/**
 * Expands a command corpus through npm script bodies until it stops growing.
 * Returns the full reachable command text per workflow.
 */
export function reachableCommands(root = process.cwd()) {
  const workflowDirectory = join(root, '.github', 'workflows');
  const files = readdirSync(workflowDirectory).filter((name) => /\.ya?ml$/.test(name));
  if (files.length === 0) {
    throw new Error(
      `No workflow files found under ${workflowDirectory}. Refusing to report "nothing runs".`,
    );
  }

  const manifests = new Map();
  const manifest = (directory) => {
    const key = normalize(directory) || '.';
    if (!manifests.has(key)) manifests.set(key, manifestFor(root, key === '.' ? '' : key));
    return manifests.get(key);
  };

  const perWorkflow = new Map();
  const triggers = new Map();

  for (const name of files) {
    const file = join(workflowDirectory, name);
    const steps = readWorkflow(file);
    if (steps.length === 0) {
      throw new Error(
        `${name} yielded no run steps. Either the workflow is empty or this parser stopped understanding it; ` +
          'both must fail loudly rather than silently reporting nothing runs.',
      );
    }

    const head = readFileSync(file, 'utf8');
    triggers.set(name, {
      push: /^\s{2}push:/m.test(head),
      pullRequest: /^\s{2}pull_request:/m.test(head),
      dispatch: /^\s{2}workflow_dispatch:/m.test(head),
      schedule: /^\s{2}schedule:/m.test(head),
    });

    const collected = [];
    const seen = new Set();
    const queue = steps.map((step) => ({ ...step }));
    while (queue.length > 0) {
      const step = queue.shift();
      const base = step.workingDirectory === '.' ? '' : step.workingDirectory;
      // Record the text resolved against its directory so a path match is not
      // ambiguous between the root workspace and v2.
      collected.push({ directory: base || '.', text: step.text });

      for (const command of step.text.split(/&&|\|\||;|\n/)) {
        const invocation = /\bnpm\s+((?:--\S+\s+\S+\s+|--\S+\s+)*)(run\s+([\w:.-]+)|test\b)/.exec(
          command,
        );
        if (!invocation) continue;
        if (/--workspace|-w\s/.test(command)) continue; // runs a workspace's script, not this manifest's
        const prefix = /--prefix\s+(\S+)/.exec(invocation[1])?.[1];
        const directory = normalize(relative(root, resolve(root, base, prefix ?? '.')));
        const script = invocation[3] ?? 'test';
        const key = `${directory}::${script}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const found = manifest(directory);
        const body = found?.scripts?.[script];
        if (typeof body === 'string')
          queue.push({ workingDirectory: directory || '.', text: body });
      }
    }
    perWorkflow.set(name, collected);
  }

  return { perWorkflow, triggers, workflowFiles: files };
}

/**
 * Which workflows execute `path` (repository-relative, forward slashes).
 *
 * A reference counts when the command text names the path either in full or
 * relative to the directory the command runs in — `npm --prefix v2 run
 * test:unit` names `packages/core/src/x.test.ts`, which is `packages/...`
 * from the repository root.
 */
export function workflowsExecuting(path, resolution) {
  const wanted = normalize(path);
  const matches = [];
  for (const [workflow, steps] of resolution.perWorkflow) {
    for (const { directory, text } of steps) {
      const relativeToStep =
        directory === '.' || !wanted.startsWith(`${directory}/`)
          ? undefined
          : wanted.slice(directory.length + 1);
      const candidates = [wanted, relativeToStep].filter(Boolean);
      if (candidates.some((candidate) => text.includes(candidate))) {
        matches.push(workflow);
        break;
      }
    }
  }
  return matches;
}

/**
 * Files under `directory` matching `predicate`, ignoring build and dependency
 * output.
 *
 * F-52-4: a directory that does not exist is a knowable fact and returns
 * nothing. Any *other* read failure throws. Swallowing one unreadable
 * subdirectory would under-report by however much lived in it, and the callers'
 * "found too few to have looked" floors only catch a total failure — a partial
 * one would sail past them having quietly excused whatever it could not read.
 */
export function walk(directory, predicate, root, found = []) {
  let entries;
  try {
    entries = readdirSync(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return found;
    throw new Error(
      `Could not read ${directory} (${error.code ?? error.message}). ` +
        'Refusing to report a partial listing as a complete one.',
      { cause: error },
    );
  }
  for (const entry of entries) {
    if (['node_modules', 'dist', '.next', '.git', 'test-results'].includes(entry)) continue;
    const absolute = join(directory, entry);
    if (statSync(absolute).isDirectory()) walk(absolute, predicate, root, found);
    else if (predicate(entry, absolute)) found.push(normalize(relative(root, absolute)));
  }
  return found;
}
