import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { loadEngineering, readRevision, safeContractFile } from './engineering.mjs';

export const CHECKS = Object.freeze({
  'engineering-tests': Object.freeze([
    '--test',
    '--test-isolation=none',
    '--test-reporter=tap',
    'scripts/engineering.test.mjs',
    'scripts/engineering-contract.test.mjs',
    'scripts/engineering-hook.test.mjs',
  ]),
  'agent-validator': Object.freeze(['scripts/check-agents.mjs']),
  'customization-validator': Object.freeze(['scripts/check-customizations.mjs']),
  'skill-validator': Object.freeze(['scripts/check-skills.mjs']),
  'engineering-check': Object.freeze(['scripts/engineering.mjs', 'check']),
  'engineering-verify': Object.freeze(['scripts/engineering.mjs', 'verify']),
});
const requireThat = (condition, message) => {
  if (!condition) throw new Error(message);
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function childEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([key, value]) =>
        /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR)$/i.test(key) && typeof value === 'string',
    ),
  );
}

export function testTotals(output) {
  if (typeof output !== 'string') return null;
  if (!output.startsWith('TAP version 13\n') && !output.startsWith('TAP version 13\r\n'))
    return null;
  const lines = output.split(/\r?\n/);
  if (lines.some((line) => line.trimStart().toLowerCase().startsWith('bail out!'))) return null;
  const actual = { tests: 0, suites: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
  let cursor = 1;
  let namedTest = false;
  let unsuccessful = false;
  const level = (indent) => {
    let count = 0;
    while (lines[cursor]?.startsWith(`${indent}# Subtest: `)) {
      const name = lines[cursor++].slice(indent.length + '# Subtest: '.length);
      requireThat(name.length > 0, 'Missing subtest name');
      namedTest ||= !name.endsWith('.test.mjs');
      if (lines[cursor]?.startsWith(`${indent}    `)) level(`${indent}    `);
      const result = new RegExp(String.raw`^${indent}(not )?ok (\d+)(?: - [^\r\n]*)?$`).exec(
        lines[cursor++],
      );
      requireThat(result && Number(result[2]) === ++count, 'Invalid result sequence');
      const directive = / # (SKIP|TODO)\b/i.exec(result[0])?.[1].toUpperCase();
      let type = 'test';
      let failureType = '';
      if (lines[cursor] === `${indent}  ---`) {
        cursor++;
        const metadata = new Set();
        while (lines[cursor] !== `${indent}  ...`) {
          const line = lines[cursor++];
          requireThat(line?.startsWith(`${indent}  `), 'Unclosed diagnostics');
          const field = new RegExp(`^${indent}  (type|failureType): '([^']+)'$`).exec(line);
          if (field) {
            requireThat(!metadata.has(field[1]), 'Duplicate outcome metadata');
            metadata.add(field[1]);
            if (field[1] === 'type') type = field[2];
            else failureType = field[2];
          } else
            requireThat(
              !new RegExp(`^${indent}  (type|failureType):`).test(line),
              'Malformed outcome metadata',
            );
        }
        cursor++;
      }
      requireThat(type === 'test' || type === 'suite', 'Unknown outcome type');
      unsuccessful ||= Boolean(result[1] || directive);
      if (type === 'suite') actual.suites++;
      else {
        actual.tests++;
        let outcome = result[1] ? 'fail' : 'pass';
        if (
          result[1] &&
          ['cancelledByParent', 'testTimeoutFailure', 'testAborted'].includes(failureType)
        )
          outcome = 'cancelled';
        if (directive === 'SKIP') outcome = 'skipped';
        if (directive === 'TODO') outcome = 'todo';
        actual[outcome]++;
      }
    }
    const plan = new RegExp(String.raw`^${indent}1\.\.(\d+)$`).exec(lines[cursor++]);
    requireThat(plan && Number(plan[1]) === count, 'Missing or mismatched plan');
  };
  try {
    level('');
    const totals = {};
    for (const name of Object.keys(actual)) {
      const summary = new RegExp(String.raw`^# ${name} (\d+)$`).exec(lines[cursor++]);
      requireThat(summary && Number(summary[1]) === actual[name], 'Mismatched totals');
      if (name !== 'suites') totals[name] = Number(summary[1]);
    }
    requireThat(/^# duration_ms \d+(?:\.\d+)?$/.test(lines[cursor++]), 'Missing duration');
    requireThat(
      lines.slice(cursor).every((line) => line === ''),
      'Unexpected trailing output',
    );
    requireThat(namedTest && totals.tests > 0, 'No actual tests');
    requireThat(!unsuccessful || totals.pass < totals.tests, 'Hidden unsuccessful outcome');
    return totals;
  } catch {
    return null;
  }
}

export function runCheck(id, { root, timeout = 120000, outputLimit = 1024 * 1024 } = {}) {
  requireThat(typeof id === 'string' && Object.hasOwn(CHECKS, id), 'Unknown check ID');
  requireThat(
    typeof root === 'string' &&
      isAbsolute(root) &&
      !lstatSync(root).isSymbolicLink() &&
      lstatSync(root).isDirectory(),
    'Safe absolute cwd required',
  );
  requireThat(
    Number.isSafeInteger(timeout) &&
      timeout >= 1 &&
      timeout <= 120000 &&
      Number.isSafeInteger(outputLimit) &&
      outputLimit >= 1 &&
      outputLimit <= 1024 * 1024,
    'Invalid execution bounds',
  );
  const cwd = realpathSync(root);
  const before = loadEngineering(cwd).result;
  requireThat(before.valid, 'Invalid engineering artifacts');
  const revision = readRevision(cwd);
  const commandDigest = () =>
    hash(
      JSON.stringify(
        CHECKS[id].map((argument) =>
          argument.startsWith('scripts/')
            ? [argument, hash(readFileSync(safeContractFile(cwd, argument)))]
            : argument,
        ),
      ),
    );
  const scriptDigest = commandDigest();
  const startedAt = new Date().toISOString();
  const child = spawnSync(process.execPath, CHECKS[id], {
    cwd,
    env: childEnvironment(process.env),
    shell: false,
    windowsHide: true,
    timeout,
    maxBuffer: outputLimit,
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const endedAt = new Date().toISOString();
  const stdout = child.stdout ?? Buffer.alloc(0);
  const stderr = child.stderr ?? Buffer.alloc(0);
  const timedOut = child.error?.code === 'ETIMEDOUT';
  const truncated = child.error?.code === 'ENOBUFS' || stdout.length + stderr.length > outputLimit;
  const totals = id === 'engineering-tests' ? testTotals(stdout.toString('utf8')) : null;
  let bindingUnchanged = false;
  try {
    const after = loadEngineering(cwd).result;
    bindingUnchanged =
      after.valid &&
      after.digest === before.digest &&
      readRevision(cwd) === revision &&
      commandDigest() === scriptDigest;
  } catch {
    bindingUnchanged = false;
  }
  const passed =
    !child.error &&
    !child.signal &&
    child.status === 0 &&
    !timedOut &&
    !truncated &&
    bindingUnchanged &&
    (id !== 'engineering-tests' ||
      (totals &&
        totals.tests > 0 &&
        totals.pass === totals.tests &&
        totals.skipped === 0 &&
        totals.todo === 0 &&
        totals.fail === 0 &&
        totals.cancelled === 0));
  return {
    schemaVersion: 1,
    checkId: id,
    command: [process.execPath, ...CHECKS[id]],
    revision,
    digest: before.digest,
    commandDigest: scriptDigest,
    startedAt,
    endedAt,
    exitCode: child.status,
    result: passed ? 'PASS' : timedOut ? 'TIMEOUT' : truncated ? 'TRUNCATED' : 'FAIL',
    success: Boolean(passed),
    timedOut,
    truncated,
    bindingUnchanged,
    stdout: { digest: hash(stdout), bytes: stdout.length },
    stderr: { digest: hash(stderr), bytes: stderr.length },
    totals,
  };
}

export function main(
  args = process.argv.slice(2),
  root = dirname(dirname(fileURLToPath(import.meta.url))),
) {
  let output;
  let code = 0;
  try {
    requireThat(
      Array.isArray(args) && args.every((value) => typeof value === 'string'),
      'Malformed arguments',
    );
    if (args.length === 1 && args[0] === 'help') {
      output = {
        usage: 'node scripts/engineering-runner.mjs help|list|run <id>',
        limits:
          'Opt-in local checks only; no scheduling or writes by the runner. Mutable scripts require review; this is not a sandbox. Output is hashed, not disclosed. No runner self-test recursion.',
      };
    } else if (args.length === 1 && args[0] === 'list') {
      output = { checks: CHECKS };
    } else {
      requireThat(args.length === 2 && args[0] === 'run', 'Unknown command or extra arguments');
      output = runCheck(args[1], { root });
      code = output.success ? 0 : 1;
    }
  } catch {
    output = {
      success: false,
      result: 'ERROR',
      error:
        'Invalid command, artifacts or execution prerequisites; use help/list and engineering check.',
    };
    code = 1;
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
  return code;
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
)
  process.exitCode = main();
