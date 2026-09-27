// CS-8: every reader of .ai/*.json must distinguish absent, valid and
// unparseable. Collapsing "cannot parse" into "empty" is how a corrupt
// findings.json once made release-gate.mjs print PASS with zero findings; this
// proves the same class of defect is fixed (and stays fixed) in the two other
// readers audited for CS-8: the engineering control center's web UI and its
// terminal counterpart, plus the agent-config validator's direct JSON reads.
//
// Run: node scripts/check-state-readers.mjs
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const FILES = {
  backlog: '.ai/backlog.json',
  findings: '.ai/findings.json',
  progress: '.ai/progress.json',
  loop: '.ai/LOOP-STATE.json',
};

// process.env.TEMP is Windows-only; tmpdir() works on both.
const backups = {};
for (const [key, path] of Object.entries(FILES)) {
  const bak = join(tmpdir(), `careerscope-state-readers-${key}.bak`);
  copyFileSync(path, bak);
  backups[key] = bak;
}

const restoreAll = () => {
  for (const [key, path] of Object.entries(FILES)) {
    if (!existsSync(path)) renameSync(backups[key], path);
    else copyFileSync(backups[key], path);
  }
};
const cleanupBackups = () => {
  for (const bak of Object.values(backups)) if (existsSync(bak)) unlinkSync(bak);
};

// Renames path away, runs fn(), and always renames it back - even if fn()
// throws or an expectation fails partway through. A bare renameSync pair with
// no finally (the original shape of this helper) would leak the renamed file
// on any exception between the two renames; restoreAll() would then recreate
// good content at `path` from backup, but the orphaned `${path}.absent-test`
// would be left behind, dirtying the working tree. (Independent Reviewer
// finding on CS-8.)
function withAbsent(path, fn) {
  const tmp = `${path}.absent-test`;
  renameSync(path, tmp);
  try {
    return fn();
  } finally {
    renameSync(tmp, path);
  }
}

let failures = 0;
const expect = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(58)} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
  if (!ok) failures += 1;
};
const expectTrue = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failures += 1;
};

try {
  // ---------------------------------------------------------------------
  // engineering-ui.mjs: snapshot() is imported directly (no HTTP server is
  // started - see the process.argv[1] entry-point guard in that file), so
  // this proves the same reader the actual dashboard uses, not a re-
  // implementation of it.
  // ---------------------------------------------------------------------
  restoreAll();
  const { snapshot } = await import('./engineering-ui.mjs?t=' + Date.now());

  {
    const snap = snapshot();
    expect('engineering-ui: valid state produces no stateErrors', snap.stateErrors, []);
  }

  writeFileSync(FILES.backlog, '{ not json');
  {
    const snap = snapshot();
    expect('engineering-ui: malformed backlog.json falls back to items:[]', snap.backlog, {
      items: [],
    });
    expectTrue(
      'engineering-ui: malformed backlog.json is reported in stateErrors',
      snap.stateErrors.some((e) => e.includes('backlog.json')),
    );
  }
  restoreAll();

  writeFileSync(FILES.findings, '{ not json');
  {
    const snap = snapshot();
    expect('engineering-ui: malformed findings.json falls back to findings:[]', snap.findings, {
      findings: [],
    });
    expectTrue(
      'engineering-ui: malformed findings.json is reported in stateErrors',
      snap.stateErrors.some((e) => e.includes('findings.json')),
    );
  }
  restoreAll();

  writeFileSync(FILES.progress, '{ not json');
  {
    const snap = snapshot();
    expect('engineering-ui: malformed progress.json falls back to areas:[]', snap.progress, {
      areas: [],
    });
    expectTrue(
      'engineering-ui: malformed progress.json is reported in stateErrors',
      snap.stateErrors.some((e) => e.includes('progress.json')),
    );
  }
  restoreAll();

  writeFileSync(FILES.loop, '{ not json');
  {
    const snap = snapshot();
    expect('engineering-ui: malformed LOOP-STATE.json falls back to {}', snap.loop, {});
    expectTrue(
      'engineering-ui: malformed LOOP-STATE.json is reported in stateErrors',
      snap.stateErrors.some((e) => e.includes('LOOP-STATE.json')),
    );
  }
  restoreAll();

  // Absent is a third, distinct state: it must NOT be reported the same way
  // as corruption. progress.json is legitimately allowed to not exist yet.
  withAbsent(FILES.progress, () => {
    const snap = snapshot();
    expect('engineering-ui: absent progress.json falls back to areas:[]', snap.progress, {
      areas: [],
    });
    expectTrue(
      'engineering-ui: absent progress.json is NOT reported as a state error',
      !snap.stateErrors.some((e) => e.includes('progress.json')),
    );
  });

  // ---------------------------------------------------------------------
  // control-center.mjs: spawned as a real process, exactly as an operator
  // would run it, so the render() early-return path is exercised for real.
  // ---------------------------------------------------------------------
  restoreAll();
  const runCC = () =>
    execFileSync(process.execPath, ['scripts/control-center.mjs'], {
      encoding: 'utf8',
    });

  expectTrue(
    'control-center: valid progress.json renders without an UNREADABLE line',
    !runCC().includes('UNREADABLE'),
  );

  writeFileSync(FILES.progress, '{ not json');
  {
    const out = runCC();
    expectTrue(
      'control-center: malformed progress.json renders UNREADABLE, not "No progress matrix found"',
      out.includes('UNREADABLE') && !out.includes('No progress matrix found'),
    );
  }
  restoreAll();

  // ---------------------------------------------------------------------
  // check-agents.mjs: spawned for real. A pre-fix run would crash on the
  // first malformed file with an uncaught exception, printing zero of the
  // checks that follow. The fix must keep running to the final summary line
  // and report a specific FAIL for the file that could not be parsed.
  // ---------------------------------------------------------------------
  restoreAll();
  const runAgents = () => {
    try {
      return {
        code: 0,
        out: execFileSync(process.execPath, ['scripts/check-agents.mjs'], { encoding: 'utf8' }),
      };
    } catch (error) {
      return { code: error.status ?? 1, out: (error.stdout ?? '') + (error.stderr ?? '') };
    }
  };

  {
    const { out } = runAgents();
    expectTrue(
      'check-agents: valid state reaches the final summary line',
      out.includes('agent configuration valid'),
    );
  }

  writeFileSync(FILES.loop, '{ not json');
  {
    const { code, out } = runAgents();
    expectTrue(
      'check-agents: malformed LOOP-STATE.json does not crash (reaches its own summary)',
      /\d+ failure\(s\)|agent configuration valid/.test(out),
    );
    expectTrue(
      'check-agents: malformed LOOP-STATE.json is reported by name, not a stack trace',
      out.includes('.ai/LOOP-STATE.json is valid JSON'),
    );
    expectTrue('check-agents: malformed LOOP-STATE.json exits non-zero', code !== 0);
  }
  restoreAll();

  writeFileSync(FILES.progress, '{ not json');
  {
    const { out } = runAgents();
    expectTrue(
      'check-agents: malformed progress.json reported by name, not a stack trace',
      out.includes('.ai/progress.json is valid JSON'),
    );
    expectTrue(
      'check-agents: malformed progress.json still reaches the final summary line',
      /\d+ failure\(s\)|agent configuration valid/.test(out),
    );
  }
  restoreAll();

  // Absence, not just corruption. This is the gap the Independent Reviewer
  // found: readJSON() was proven only against malformed input, so two other
  // unconditional reads in check-agents.mjs (the CAREERSCOPE-PROGRESS.md read
  // and the secret-scan's readFileSync loop) still crashed uncaught on an
  // absent file - including .ai/LOOP-STATE.json itself, the file readJSON()
  // was supposed to protect. Both are now fixed; these prove it.
  withAbsent(FILES.loop, () => {
    const { code, out } = runAgents();
    expectTrue(
      'check-agents: absent LOOP-STATE.json does not crash (reaches its own summary)',
      /\d+ failure\(s\)|agent configuration valid/.test(out),
    );
    expectTrue(
      'check-agents: absent LOOP-STATE.json is reported by name, not a stack trace',
      out.includes('.ai/LOOP-STATE.json is readable (missing)'),
    );
    expectTrue('check-agents: absent LOOP-STATE.json exits non-zero', code !== 0);
  });

  withAbsent('.ai/CAREERSCOPE-PROGRESS.md', () => {
    const { code, out } = runAgents();
    expectTrue(
      'check-agents: absent CAREERSCOPE-PROGRESS.md does not crash (reaches its own summary)',
      /\d+ failure\(s\)|agent configuration valid/.test(out),
    );
    expectTrue(
      'check-agents: absent CAREERSCOPE-PROGRESS.md is reported by name, not a stack trace',
      out.includes('.ai/CAREERSCOPE-PROGRESS.md is readable'),
    );
    expectTrue('check-agents: absent CAREERSCOPE-PROGRESS.md exits non-zero', code !== 0);
  });
} finally {
  restoreAll();
  cleanupBackups();
}

console.log(
  `\n${failures === 0 ? 'ALL STATE READERS PROVEN' : `${failures} check(s) did not behave`}`,
);
process.exit(failures === 0 ? 0 : 1);
