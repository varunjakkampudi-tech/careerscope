#!/usr/bin/env node
/**
 * CareerScope Engineering Control Center.
 *
 * An observability layer over the real engineering state. Every value printed is
 * read from a file in the repository; nothing is simulated, and no percentage is
 * computed here. If a fact is unknown, this prints that it is unknown rather
 * than inventing a plausible-looking one.
 *
 * The honest limit worth knowing before trusting this screen: VS Code does not
 * publish agent runtime to disk, so "active agent" is whatever the Orchestrator
 * last recorded in `.ai/LOOP-STATE.json`. A recorded RUNNING state that has not
 * been touched for a while is therefore reported as STALE rather than animated,
 * because a spinner over an abandoned run is exactly the fake activity this tool
 * exists to avoid.
 *
 *   node scripts/control-center.mjs           one render
 *   node scripts/control-center.mjs --watch    re-render when .ai/ changes
 *   node scripts/control-center.mjs --json     machine-readable, no ANSI
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, watch } from 'node:fs';
import { join } from 'node:path';

const AI = '.ai';
const AGENTS = '.github/agents';
const REVIEW = 'review.txt';
const STALE_AFTER_MS = 15 * 60 * 1000;

const colour = process.stdout.isTTY && !process.argv.includes('--json');
const c = (code, text) => (colour ? `\u001b[${code}m${text}\u001b[0m` : text);
const dim = (t) => c('2', t);
const bold = (t) => c('1', t);
const green = (t) => c('32', t);
const yellow = (t) => c('33', t);
const red = (t) => c('31', t);
const cyan = (t) => c('36', t);
const grey = (t) => c('90', t);

// Normalised because the repository is checked out with CRLF on Windows, and
// every `^...$` pattern below would otherwise fail silently rather than error.
const read = (path) =>
  existsSync(path) ? readFileSync(path, 'utf8').replace(/\r\n/g, '\n') : null;

/* ---------------------------------------------------------------- state --- */

function loopState() {
  const raw = read(join(AI, 'LOOP-STATE.json'));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (error) {
    return { parseError: error.message };
  }
}

/**
 * Progress comes from .ai/progress.json, never from the Markdown.
 *
 * Parsing prose with regex produced three silent false negatives in this
 * repository, so structured state is canonical and the Markdown is the human
 * projection. check-agents.mjs asserts the two agree.
 */
function progress() {
  const raw = read(join(AI, 'progress.json'));
  if (!raw) return [];
  try {
    return JSON.parse(raw).areas ?? [];
  } catch {
    return [];
  }
}

/** The previous committed figures, so a regression cannot be quietly dropped. */
function previousProgress() {
  try {
    const commits = execFileSync('git', ['log', '-2', '--format=%H', '--', `${AI}/progress.json`], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);
    if (commits.length < 2) return null;
    const older = JSON.parse(
      execFileSync('git', ['show', `${commits[1]}:${AI}/progress.json`], { encoding: 'utf8' }),
    );
    return new Map((older.areas ?? []).map((a) => [a.area, a.percent]));
  } catch {
    return null;
  }
}

/** Permission is derived from the agent's actual tool list, not from a label. */
function agents() {
  if (!existsSync(AGENTS)) return [];
  return readdirSync(AGENTS)
    .filter((f) => f.endsWith('.agent.md'))
    .map((file) => {
      const body = readFileSync(join(AGENTS, file), 'utf8');
      const front = body.slice(0, body.indexOf('\n---', 4));
      const tools = [...front.matchAll(/'([^']+)'/g)].map((m) => m[1]);
      return {
        id: file.replace('.agent.md', ''),
        name: /^name:\s*(.+)$/m.exec(front)?.[1]?.trim() ?? file,
        write: tools.includes('edit'),
        execute: tools.some((t) => t === 'execute' || t.startsWith('execute/')),
      };
    });
}

/** Findings come from .ai/findings.json. An empty list means zero, not unknown. */
function findings() {
  const raw = read(join(AI, 'findings.json'));
  if (!raw) return [];
  try {
    return JSON.parse(raw).findings ?? [];
  } catch {
    return [];
  }
}

/** The newest review.txt entry, which is the last thing actually performed. */
function lastEntry() {
  const body = read(REVIEW);
  if (!body) return null;
  const index = body.lastIndexOf('\nENTRY\n');
  if (index === -1) return null;
  const entry = body.slice(index);
  const field = (label) => new RegExp(`^${label}:\\s*(.+)$`, 'm').exec(entry)?.[1]?.trim() ?? null;
  const section = (heading) =>
    new RegExp(`## ${heading}\\n+([\\s\\S]*?)(?=\\n## |\\n=====)`, 'm')
      .exec(entry)?.[1]
      ?.trim()
      .split('\n')
      .filter(Boolean)
      .slice(0, 4)
      .join('\n') ?? null;
  return {
    date: field('Date'),
    task: field('Task'),
    status: section('FINAL STATUS'),
    next: section('NEXT ACTION'),
  };
}

/* --------------------------------------------------------------- render --- */

const STATE_STYLE = {
  WAITING: grey,
  RUNNING: cyan,
  REVIEWING: cyan,
  IMPLEMENTING: cyan,
  TESTING: cyan,
  BLOCKED: red,
  FAILED: red,
  PASSED: green,
  COMPLETE: green,
};
const MARK = { WAITING: '○', BLOCKED: '!', FAILED: '✕', PASSED: '✓', COMPLETE: '✓' };

function bar(percent, width = 20) {
  const filled = Math.round((percent / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function duration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// Animation is only ever applied to an agent with a fresh heartbeat. A spinner
// over a run that has gone quiet is the fake activity this tool exists to avoid,
// so a stale agent keeps a static mark and is labelled STALE instead.
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let frame = 0;

function render() {
  const loop = loopState();
  const out = [];
  const line = (text = '') => out.push(text);

  line();
  line(bold('  CAREERSCOPE AI ENGINEERING'));
  line(dim('  ─────────────────────────────────────────────────────────────'));

  if (!loop) {
    line(red('  .ai/LOOP-STATE.json is missing. No engineering state to show.'));
    return out.join('\n');
  }
  if (loop.parseError) {
    line(red(`  .ai/LOOP-STATE.json is not valid JSON: ${loop.parseError}`));
    return out.join('\n');
  }

  // Staleness is load-bearing: it is what stops this screen implying that an
  // abandoned run is still in progress.
  const updatedAt = loop.updatedAt ? Date.parse(loop.updatedAt) : null;
  const rawAge = updatedAt ? Date.now() - updatedAt : null;
  // A future timestamp means a clock disagreement, not a fresh state.
  const age = rawAge !== null && rawAge >= 0 ? rawAge : null;
  const skewed = rawAge !== null && rawAge < 0;
  const running = ['RUNNING', 'REVIEWING', 'IMPLEMENTING', 'TESTING'].includes(
    String(loop.status).toUpperCase(),
  );
  // The heartbeat is the liveness signal; updatedAt only says the file changed.
  const beat = loop.lastHeartbeat ? Date.now() - Date.parse(loop.lastHeartbeat) : age;
  const stale = running && beat !== null && beat > STALE_AFTER_MS;

  line(`  Task        ${loop.task ?? dim('none accepted')}`);
  line(`  Phase       ${loop.phase ?? dim('unknown')}    Iteration  ${loop.iteration ?? 0}`);
  const statusText = String(loop.status ?? 'unknown');
  const style = STATE_STYLE[statusText.toUpperCase()] ?? ((t) => t);
  line(
    `  Status      ${style(statusText)}${stale ? red('   STALE — recorded as running but not updated') : ''}`,
  );

  if (loop.activeAgent) {
    const meta = agents().find((a) => a.id === loop.activeAgent);
    line();
    line(`  Active      ${bold(meta?.name ?? loop.activeAgent)}`);
    line(`  Model       ${loop.model ?? yellow('UNPINNED / PICKER CONTROLLED')}`);
    line(
      `  Permission  ${meta ? (meta.write ? yellow('WRITE ENABLED') : green('READ ONLY')) : dim('unknown')}`,
    );
    // VS Code exposes no agent runtime, so this is a record and says so.
    line(
      `  State       ${yellow(loop.stateSource ?? 'REPORTED')} ${dim('— self-declared, not probed')}`,
    );
    line(`  Operation   ${loop.currentOperation ?? dim('not recorded')}`);
    if (loop.sourceCommit) line(`  Commit      ${loop.sourceCommit}`);
    if (loop.lastHeartbeat) {
      line(`  Heartbeat   ${duration(beat)} ago${stale ? red('   STALE') : ''}`);
    }
    if (loop.startedAt) {
      line(
        `  Elapsed     ${duration(Date.now() - Date.parse(loop.startedAt))}${stale ? red(' (stale)') : ''}`,
      );
    }
  } else {
    line();
    line(`  Active      ${dim('no agent recorded as running')}`);
  }
  if (age !== null)
    line(`  State age   ${duration(age)} ${dim('since LOOP-STATE.json was updated')}`);
  if (skewed)
    line(`  State age   ${yellow(`${loop.updatedAt} is in the future — check the clock`)}`);

  // Agents
  line();
  line(bold('  AGENTS'));
  const recorded = loop.agents ?? {};
  for (const agent of agents().sort((a, b) => a.name.localeCompare(b.name))) {
    const state = String(recorded[agent.id] ?? 'WAITING').toUpperCase();
    const paint = STATE_STYLE[state] ?? ((t) => t);
    const busy = !['WAITING', 'COMPLETE', 'PASSED', 'FAILED', 'BLOCKED'].includes(state);
    const live = busy && !stale && agent.id === loop.activeAgent;
    const mark = live ? SPINNER[frame % SPINNER.length] : (MARK[state] ?? '●');
    const active = agent.id === loop.activeAgent;
    // Execute-without-edit is a real third tier: QA can run things, not change them.
    const permission = agent.write
      ? yellow('WRITE')
      : agent.execute
        ? cyan('EXECUTE')
        : green('READ ONLY');
    line(
      `  ${paint(mark)} ${(active ? bold : (t) => t)(agent.name.padEnd(34))} ${paint(state.padEnd(13))} ${permission}`,
    );
  }

  // Progress
  const rows = progress();
  const before = previousProgress();
  line();
  line(bold('  PROGRESS') + dim('   (from .ai/progress.json)'));
  if (rows.length === 0) {
    line(dim('  No progress matrix found.'));
  }
  for (const row of rows) {
    const was = before?.get(row.area);
    let delta = dim('     ');
    if (was !== undefined && was !== row.percent) {
      const change = row.percent - was;
      delta = change > 0 ? green(`  +${change}%`) : red(`  ${change}%`);
    }
    line(
      `  ${row.area.padEnd(15)} ${bar(row.percent)} ${String(row.percent).padStart(3)}%${delta}`,
    );
  }

  // Findings
  const found = findings();
  const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const item of found) if (item.severity in counts) counts[item.severity] += 1;
  line();
  line(bold('  REVIEW FINDINGS') + dim('   (.ai/findings.json)'));
  const paintSeverity = { P0: red, P1: red, P2: yellow, P3: grey };
  for (const severity of ['P0', 'P1', 'P2', 'P3']) {
    line(`  ${paintSeverity[severity]('█')} ${severity}  ${counts[severity]}`);
  }
  for (const item of found.slice(0, 6)) {
    const where = item.file ?? item.where ?? '—';
    line(
      dim(
        `      ${item.severity}  ${item.foundBy ?? item.origin ?? '—'} — ${where}  [${item.status ?? 'OPEN'}]`,
      ),
    );
  }
  if (found.length === 0) line(dim('      No findings recorded.'));

  // Activity
  line();
  line(bold('  ACTIVITY'));
  const activity = Array.isArray(loop.activity) ? loop.activity : [];
  if (activity.length === 0) {
    line(dim('      No recorded activity. Events appear here once an agent run is logged.'));
  }
  for (const event of activity.slice(-10)) {
    const at = event.at ? new Date(event.at).toLocaleTimeString() : '—';
    line(`      ${dim(at)}  ${(event.agent ?? '').padEnd(28)} ${event.event ?? ''}`);
  }

  // Last / next
  const entry = lastEntry();
  line();
  line(bold('  LAST RECORDED CYCLE') + dim('   (review.txt)'));
  if (!entry) {
    line(dim('      No entries yet.'));
  } else {
    line(`      ${entry.date ?? '—'}  ${entry.task ?? '—'}`);
    if (entry.status) for (const l of entry.status.split('\n')) line(dim(`      ${l}`));
    line();
    line(bold('  NEXT ACTION'));
    for (const l of (entry.next ?? '—').split('\n')) line(`      ${l}`);
  }

  // Completion is never asserted by this tool; it only reports the gate.
  line();
  const complete =
    String(loop.status).toUpperCase() === 'COMPLETE' &&
    counts.P0 === 0 &&
    counts.P1 === 0 &&
    rows.length > 0 &&
    rows.every((r) => r.percent === 100);
  line(
    complete
      ? green(bold('  CAREERSCOPE ENGINEERING COMPLETE — 100% VERIFIED'))
      : dim(`  Not complete. ${incompleteReason(loop, rows, counts)}`),
  );
  line();
  return out.join('\n');
}

function incompleteReason(loop, rows, counts) {
  const reasons = [];
  if (String(loop.status).toUpperCase() !== 'COMPLETE') reasons.push(`status is ${loop.status}`);
  if (counts.P0) reasons.push(`${counts.P0} open P0`);
  if (counts.P1) reasons.push(`${counts.P1} open P1`);
  const below = rows.filter((r) => r.percent < 100).map((r) => r.area);
  if (below.length) reasons.push(`below 100%: ${below.join(', ')}`);
  return reasons.join(' · ') || 'gates not evaluated';
}

/* ------------------------------------------------------------------ main --- */

if (process.argv.includes('--json')) {
  const loop = loopState();
  process.stdout.write(
    `${JSON.stringify(
      {
        loop,
        progress: progress(),
        findings: findings(),
        agents: agents(),
        lastEntry: lastEntry(),
      },
      null,
      2,
    )}\n`,
  );
} else if (process.argv.includes('--watch')) {
  let timer;
  const draw = () => {
    process.stdout.write('\u001b[2J\u001b[H');
    process.stdout.write(`${render()}\n`);
    process.stdout.write(dim('  watching .ai/ — Ctrl+C to stop\n'));
  };
  draw();
  // Only spin while an agent is genuinely live. When nothing is running the
  // screen is static, so motion on it always means something is actually
  // happening rather than that the process is merely alive.
  let ticking = false;
  setInterval(() => {
    const loop = loopState();
    const beat = loop?.lastHeartbeat ? Date.now() - Date.parse(loop.lastHeartbeat) : null;
    const live =
      Boolean(loop?.activeAgent) &&
      ['RUNNING', 'REVIEWING', 'IMPLEMENTING', 'TESTING'].includes(
        String(loop.status).toUpperCase(),
      ) &&
      beat !== null &&
      beat <= STALE_AFTER_MS;
    if (!live) {
      ticking = false;
      return;
    }
    ticking = true;
    frame += 1;
    draw();
  }, 120).unref?.();
  for (const target of [AI, REVIEW]) {
    if (!existsSync(target)) continue;
    watch(target, { recursive: statSync(target).isDirectory() }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!ticking) draw();
      }, 150);
    });
  }
} else {
  process.stdout.write(`${render()}\n`);
}
