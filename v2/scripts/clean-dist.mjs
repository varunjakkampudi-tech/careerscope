#!/usr/bin/env node
// Removes stale build output before a packaging build.
//
// `tsc -b` never prunes. Delete a source file, rebuild, and its emitted `.js`,
// `.d.ts` and `.js.map` stay in `dist` indefinitely — still importable, and
// invisible to `git status` because `dist/` is gitignored. Verified: after
// deleting the source, `import('./dist/__orphan_probe.js')` still resolved and
// returned its export, while `git status --porcelain` reported a clean tree.
//
// `tsc -b --clean` does NOT fix this, which is worth stating because it is the
// obvious thing to reach for and it was measured failing: it deletes the
// outputs it still knows about from the current source graph, and an orphan is
// precisely the file that has left that graph. Tried, left all three artefacts
// in place, rejected.
//
// Scope of the risk, measured rather than assumed: the deployed image cannot
// carry an orphan. `infra/v3/Dockerfile.dockerignore:31` excludes `**/dist/**`
// after its re-includes, and the shipped tree comes from `git archive`, which
// carries zero files under any `dist/`. Two independent controls. What remains
// is local: a check run against a `dist` holding a module that no longer exists
// in source is a check passing against code that is not there.

import { readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');

/** Workspace directories whose build output this may remove. */
const workspaceRoots = ['packages', 'apps', join('apps', 'workers')];

function workspaces() {
  const found = [];
  for (const group of workspaceRoots) {
    let entries;
    try {
      entries = readdirSync(join(root, group));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = join(root, group, entry);
      try {
        if (statSync(candidate).isDirectory()) found.push(candidate);
      } catch {
        /* raced away; nothing to clean */
      }
    }
  }
  return found;
}

const removed = [];
for (const workspace of workspaces()) {
  // dist and tsbuildinfo MUST be removed together. Removing only dist leaves
  // tsc believing the project is already built, so `tsc -b` skips it, emits
  // nothing, and exits 0 — and the next project fails to resolve
  // `@careerscope/core` because its dist is gone. Measured: doing exactly that
  // produced `tsc -b` exit 1 with "Cannot find module '@careerscope/core'"
  // while the build state claimed success.
  //
  // That asymmetry is almost certainly the mechanism behind the original
  // report of `tsc -b` exiting 0 over a real error: a build state that says
  // "done" over outputs that are absent or stale is the same lie in the other
  // direction.
  for (const name of ['dist', 'dist-types', 'tsconfig.tsbuildinfo']) {
    const target = join(workspace, name);
    // Never delete outside the v2 tree.
    if (!resolve(target).startsWith(resolve(root) + sep)) {
      console.error(`::error::refusing to remove ${target}, which is outside ${root}`);
      process.exit(1);
    }
    let entry;
    try {
      entry = statSync(target);
    } catch {
      continue;
    }
    if (name === 'tsconfig.tsbuildinfo' ? !entry.isFile() : !entry.isDirectory()) continue;
    rmSync(target, { recursive: true, force: true });
    removed.push(relative(root, target).split(/[\\/]/).join('/'));
  }
}

console.log(
  removed.length > 0
    ? `Cleaned ${removed.length} build artefact(s): ${removed.join(', ')}`
    : 'No build output to clean',
);
