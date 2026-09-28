#!/usr/bin/env node
// Asks, mechanically, the one question that caught four wrong promotions:
//
//   Does any acceptance criterion have a recorded unmet status — in the
//   ticket's own evidence, in docs/KNOWN-LIMITATIONS.md, or in a record it
//   depends on?
//
// Two independent UAT audits produced four confirmed demotions (CS-14, CS-17,
// CS-50, CS-19) plus CS-2, and every one was caught by that question asked
// against text already on the board, before any source file was opened. It
// needed no reviewer, no shell and no judgement — and the promotion rule never
// asked it. This closes the class rather than the five instances.
//
// SCOPE DISCIPLINE, because the alternative is a keyword-matching toy.
// This repository documents its reasoning inline and quotes the exact
// identifiers a grep would look for; that has already produced false findings
// twice. So:
//
//   - Only `evidence`, `currentStep` and `completedSteps` are scanned. Never
//     the title, userProblem or summary, which are prose about the problem
//     rather than claims about the work.
//   - Findings are graded. A phrase that names an acceptance criterion is
//     blocking; the same phrase floating free is advisory, because it is far
//     more likely to be narration.
//   - Advisory findings are reported for a human and do not fail. A promotion
//     gate with false positives gets disabled within a day, and then it
//     protects nothing.
//
// What is NOT graded, and always fails: being unable to look. An absent or
// corrupt backlog, a limitations register that will not parse, or a UAT filter
// that matches nothing are all "we cannot tell", which is not "nothing to
// report". `release-gate.mjs` once printed "no open P0 or P1" and exited 0
// against a corrupt findings file, and `engineering-ui.mjs` collapsed absent
// and unparseable into one fallback. Same file, same trap, twice already.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';

const write = (message) => process.stdout.write(`${message}\n`);
const warn = (message) => process.stderr.write(`${message}\n`);

/** Thrown for "this check cannot look", as distinct from "this ticket has a problem". */
export class CannotLook extends Error {}

const STOPWORDS = new Set([
  'the',
  'and',
  'not',
  'for',
  'are',
  'was',
  'その',
  'with',
  'from',
  'that',
  'this',
  'only',
  'into',
  'onto',
  'has',
  'have',
  'been',
  'but',
  'its',
  'it',
  'a',
  'an',
  'is',
  'of',
  'to',
  'no',
  'nothing',
  'still',
  'cannot',
  'does',
  'several',
  'one',
  'two',
  'per',
  'than',
]);

/**
 * Parses docs/KNOWN-LIMITATIONS.md into sections with their declared status.
 *
 * The register's own header states that "Status uses only the vocabulary in
 * PROJECT-STATE", and the statuses in the file are of the form
 * `**Status: OPEN — HUMAN VALIDATION**`.
 */
export function parseLimitations(markdown) {
  const sections = [];
  let current;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(.*?)\s*$/.exec(line);
    if (heading) {
      current = { heading: heading[1], status: undefined, body: [] };
      sections.push(current);
      continue;
    }
    if (!current) continue;
    const status = /^\*\*Status:\s*([^*]+?)\s*\*\*/.exec(line);
    if (status && !current.status) current.status = status[1].trim();
    current.body.push(line);
  }

  if (sections.length < 5) {
    throw new CannotLook(
      `Parsed only ${sections.length} section(s) out of the limitations register. ` +
        'That cannot be the real file, so this check could not look and must not pass.',
    );
  }

  for (const section of sections) {
    // "OPEN" and "NOT IMPLEMENTED" describe something a criterion cannot claim
    // to have satisfied. "DEFERRED" and "PARTIALLY RESOLVED" are *recorded
    // decisions* — someone looked and chose. Those are worth a human glance,
    // never a build failure: blocking on a deliberate, documented deferral
    // would train people to disable this check, and then it protects nothing.
    const status = (section.status ?? '').toUpperCase();
    section.open = /^(OPEN|NOT IMPLEMENTED)/.test(status);
    section.deferred = /^(DEFERRED|PARTIALLY)/.test(status);
    // Bigrams from the heading are what an acceptance criterion would have to
    // echo to be talking about the same thing. A single word is too loose —
    // "email" alone would match half the board.
    const words = section.heading
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .replace(/-/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
    section.phrases = [];
    for (let index = 0; index + 1 < words.length; index += 1) {
      const pair = [words[index], words[index + 1]];
      if (pair.every((word) => STOPWORDS.has(word) || word.length < 4)) continue;
      section.phrases.push(pair.join(' '));
    }
  }
  return sections;
}

/** The fields that carry claims about the work, as opposed to prose about the problem. */
function claimText(ticket) {
  const parts = [];
  const push = (label, value) => {
    if (typeof value === 'string' && value.trim()) parts.push({ label, text: value });
  };
  push('currentStep', ticket.currentStep);
  if (Array.isArray(ticket.evidence)) {
    ticket.evidence.forEach((entry, index) =>
      push(`evidence[${index}]`, typeof entry === 'string' ? entry : JSON.stringify(entry)),
    );
  }
  if (Array.isArray(ticket.completedSteps)) {
    ticket.completedSteps.forEach((entry, index) =>
      push(`completedSteps[${index}]`, typeof entry === 'string' ? entry : JSON.stringify(entry)),
    );
  }
  return parts;
}

// Shape 1. Phrases in which a ticket says, in its own record, that something is
// not done. Each is a form observed in the real demotions rather than invented.
//
// The two tiers are driven by WHAT THE DISCLOSURE SAYS ABOUT THE WORK, not by
// whether the text happens to spell "AC<n>". An earlier version graded on the
// identifier, which was backwards: naming a criterion shows the disclosure is
// precise, while not naming one shows nothing at all. CS-17's "there is no
// dismiss action and no schema support for one" names no AC and is the most
// serious residual of the four founding cases — it graded advisory and could
// not fail the gate. That is the exact defect this check exists to catch,
// inside the check itself.
//
// BLOCKING: the record states the required work is not done.
const RESIDUAL_BLOCKING = [
  /disclosed,?\s+not\s+fixed/i,
  /remains?\s+BLOCKED/i,
  /\b(is|are|was|were)\s+(unmet|not\s+met)\b/i,
  /\bunmet\s+(in|by)\b/i,
  /cannot\s+be\s+done\s+honestly/i,
  /\bthere\s+is\s+no\b[^.]{0,80}\band\s+no\s+schema\b/i,
  /\bdoes\s+not\s+use\s+it\b/i,
  /\bNOT\s+YET\s+(INSTALLED|WIRED|IMPLEMENTED)\b/i,
  /open\s+product\s+question/i,
];

// ADVISORY: the record discloses something adjacent — follow-up work, or an
// observation that is explicitly not this ticket's subject. Worth a human
// glance; not a reason to refuse promotion. Keeping these out of the blocking
// tier is what stops the gate becoming noise and getting disabled.
const RESIDUAL_ADVISORY = [
  /did\s+not\s+reproduce/i,
  /needs?\s+a\s+backend\s+ticket/i,
  /\bout\s+of\s+scope\b/i,
  /\bnot\s+(touched\s+by\s+or\s+)?related\s+to\s+this\s+change\b/i,
];

// P-4: "did not reproduce" carries two opposite meanings. Usually it is a flake
// that failed to recur on re-run — an observation, correctly advisory. But
// CS-2's demotion ground was this exact phrase meaning the opposite: "the
// specific 768px offset THIS TICKET NAMES did not reproduce", i.e. the defect
// the ticket exists to fix was never confirmed to exist at all. Same phrase,
// same two-meanings problem as CS-19/CS-51, so the tier cannot be fixed by the
// phrase. When the sentence ties the non-reproduction to the ticket's own
// subject, it is blocking.
const ADVISORY_MEANS_BLOCKING = /\bthis\s+ticket\b|\bthe\s+specific\b|\bthis\s+ticket\s+names\b/i;

// A blocking phrase that is explicitly attributed to a DIFFERENT, newly raised
// ticket is a disclosure about that ticket, not this one. CS-22 records "the
// new CS-46 ticket (the one genuine open product question this surfaced)" —
// the same words as CS-17, about somebody else's work.
// P-1: `\bsurfaced\b` was here and has been removed. It is a bare English verb
// that attributes nothing to another ticket, it is pervasive in this
// repository's prose, CS-23's AC2 is literally "is surfaced to the owner", and
// it was redundant even for its own motivating example — `\bnew\s+CS-\d+\b`
// already matches CS-22. A word any author can place within 160 characters of a
// residual to silence it is an exemption anyone can grant themselves.
const ATTRIBUTED_ELSEWHERE =
  /\bnew\s+CS-\d+\b|\b(belongs|belonging)\s+to\s+CS-\d+\b|\battributed\s+to\s+CS-\d+\b|\bits\s+own\s+ticket\b|\bseparate\s+ticket\b/i;

const normalise = (text) => text.replace(/\s+/g, ' ').replace(/[\u2010-\u2015]/g, '-');

/**
 * Assesses one ticket. Returns findings; an empty array means nothing was
 * detected, which is not the same as a guarantee that the ticket is sound.
 */
export function assess(ticket, context) {
  const findings = [];
  const criteria = Array.isArray(ticket.acceptanceCriteria) ? ticket.acceptanceCriteria : [];
  const claims = claimText(ticket);

  if (criteria.length === 0) {
    findings.push({
      ticket: ticket.id,
      shape: 'no-acceptance-criteria',
      severity: 'blocking',
      detail:
        'The ticket has no acceptance criteria at all, so nothing can have been verified against them.',
    });
    return findings;
  }

  // Shape 1 — the ticket's own record says something is not done.
  for (const { label, text } of claims) {
    const flat = normalise(text);
    let recorded = false;
    for (const [tier, patterns] of [
      ['blocking', RESIDUAL_BLOCKING],
      ['advisory', RESIDUAL_ADVISORY],
    ]) {
      if (recorded) break;
      for (const pattern of patterns) {
        const match = pattern.exec(flat);
        if (!match) continue;
        // The window is what decides attribution, so a blocking phrase that
        // belongs to a different ticket is not charged to this one.
        const window = flat.slice(Math.max(0, match.index - 160), match.index + 160);
        const elsewhere = tier === 'blocking' && ATTRIBUTED_ELSEWHERE.test(window);
        // P-4: an advisory phrase tied to the ticket's own subject is not an
        // aside about something unrelated.
        const aboutThisTicket = tier === 'advisory' && ADVISORY_MEANS_BLOCKING.test(window);
        const namesCriterion = /\bAC\s*\d\b/i.test(flat);
        findings.push({
          ticket: ticket.id,
          shape: 'self-disclosed-residual',
          severity: elsewhere ? 'advisory' : aboutThisTicket ? 'blocking' : tier,
          field: label,
          detail:
            `${label} records "${match[0].trim()}"` +
            (elsewhere ? ', attributed to a separate ticket rather than this one.' : '.') +
            (aboutThisTicket
              ? " The sentence ties it to this ticket's own subject, so it is not an aside."
              : '') +
            // Naming a criterion enriches the message; it no longer decides the tier.
            (namesCriterion ? ' The entry also cites an acceptance criterion by name.' : ''),
          quote: flat.slice(Math.max(0, match.index - 60), match.index + 140).trim(),
        });
        recorded = true;
        break; // one finding per field is enough to require a human
      }
    }
  }

  criteria.forEach((raw, index) => {
    const criterion = normalise(typeof raw === 'string' ? raw : JSON.stringify(raw));
    const name = `AC${index + 1}`;
    // Hyphens are flattened for phrase comparison only: an acceptance criterion
    // writes "screen-reader operable" while the limitations register heads its
    // section "Screen reader not validated". Without this they are two
    // different strings and the cross-reference silently never fires — which is
    // exactly how a criterion contradicted by the register would slip through.
    const lower = criterion.toLowerCase().replace(/-/g, ' ');

    // Shape 2 — a criterion demanding verification of something the
    // limitations register records as still open.
    //
    // The trigger is deliberately the strong form only. An earlier version
    // accepted a bare "validated", which fired on CS-33's "a bounded validated
    // read contract" — an adjective in a noun phrase, not a demand for
    // verification. That is the keyword-toy failure this check must not become,
    // and it produced a false BLOCKING on the first live run.
    if (/\bnot\s+assumed\b|\bverified\s+rather\s+than\s+assumed\b/i.test(criterion)) {
      for (const section of context.limitations) {
        if (!section.open && !section.deferred) continue;
        const hit = section.phrases.find((phrase) => lower.includes(phrase));
        if (!hit) continue;
        findings.push({
          ticket: ticket.id,
          shape: 'contradicted-by-limitations-register',
          severity: section.open ? 'blocking' : 'advisory',
          field: name,
          detail:
            `${name} requires verification of "${hit}", but docs/KNOWN-LIMITATIONS.md ` +
            `records "${section.heading}" as ${section.status}.`,
          quote: criterion.slice(0, 200),
        });
        break;
      }
    }

    // Shape 3 — a criterion that names CI, with no CI run recorded anywhere.
    //
    // The marker demands a LOCATOR — a run URL or a run id — not the letters
    // "CI". An earlier version accepted the phrase `CI run`, and CS-2's
    // evidence contains the sentence "...is UNCOMMITTED, so every CI run that
    // exists predates it. AC3 IS NOT MERELY UNPROVEN, IT IS UNPROVABLE". The
    // check read a sentence stating the criterion is unprovable as proof that
    // it was proven, and suppressed its own blocking finding. Prose about CI is
    // not a CI result; only something a real run produces can stand for one.
    if (/\b(in|on)\s+CI\b|\bCI[- ]enforced\b|\bCI\s+run\b/i.test(criterion)) {
      const recorded = claims.some(({ text }) =>
        /actions\/runs\/\d+|\brun[- ]?id[\s:#]+\d+/i.test(text),
      );
      if (!recorded) {
        findings.push({
          ticket: ticket.id,
          shape: 'ci-claimed-but-not-recorded',
          severity: 'blocking',
          field: name,
          detail:
            `${name} requires a result "in CI", but no evidence entry carries a workflow run URL ` +
            'or run id. A local run — even a containerised one — is not CI, and a sentence mentioning ' +
            'CI is not a CI result.',
          quote: criterion.slice(0, 200),
        });
      }
    }

    // Shape 4 — a criterion requiring the owner's confirmation, satisfied by
    // somebody who is not the owner.
    if (
      /owner[- ]confirmed|owner[- ]approved|confirmed by the owner|owner confirmation/i.test(
        criterion,
      )
    ) {
      const confirmed = claims.some(({ text }) =>
        /owner\s+(confirmed|approved|decided|signed[- ]off)|confirmed\s+by\s+the\s+owner/i.test(
          text,
        ),
      );
      if (!confirmed) {
        const substitute = claims
          .map(({ text }) =>
            /\b(ChatGPT|Claude|Copilot|GPT-\d|the agent|review loop)\b/i.exec(text),
          )
          .find(Boolean);
        findings.push({
          ticket: ticket.id,
          shape: 'owner-confirmation-substituted',
          severity: 'blocking',
          field: name,
          detail:
            `${name} requires an owner-confirmed decision and no evidence entry records one` +
            (substitute
              ? `; the record names "${substitute[0]}" instead. An agent cannot confirm on the owner's behalf.`
              : '.'),
          quote: criterion.slice(0, 200),
        });
      }
    }

    // Shape 5 — a criterion that can only be satisfied by observing a running
    // system, with no record that anyone observed one.
    //
    // CS-7, the board's only P0, sat in UAT on "proven by pushing a commit with
    // a deliberately failing check and observing deploy refuse" while its
    // evidence recorded gate-logic unit tests.
    //
    // P-2: this was an enumerated verb list — pushing|deploying|observing
    // deploy|on a real|... — and it caught 1 of the 6 tickets its own comment
    // cites. CS-3's "proven by KILLING Caddy" and CS-24's "proven by STOPPING a
    // container" both begin with "Proven by" and were missed, because the verb
    // was not on the list. A rule justified by five cases it cannot detect is
    // the instance-not-class defect, inside the check written to close a class.
    //
    // So the trigger is the criterion's DEMAND, in three forms, none of which
    // enumerates an action:
    //   A  it must be proven/demonstrated/verified/exercised by doing something
    //   B  it explicitly contrasts with reading, documenting or simulating
    //   C  it states an elapsed-time or unattended condition, which only a
    //      running system can satisfy
    const demandsDemonstration =
      // A: proven/demonstrated/verified BY doing something. The "by" matters:
      // bare "verified" is shape 2's territory ("verified not assumed" asks for
      // validation, not for a host), and treating it as a real-system demand
      // produced false blocks on CS-14 and CS-33.
      /\b(proven|demonstrated|verified|shown)\s+by\b/i.test(criterion) ||
      // A': verification of infrastructure state, which only exists on a host.
      /\bverif\w+\b[^.]{0,90}\b(ssh|firewall|inbound|ports?|host|container|deployment|origin)\b/i.test(
        criterion,
      ) ||
      // B: an explicit contrast with reading, documenting or simulating.
      /\b(exercised|performed)\b[^.]{0,40}\bnot\s+documented\b/i.test(criterion) ||
      /\bnot\s+(by\s+)?(reading|documented|documenting|simulat\w+|asserting)\b/i.test(criterion) ||
      // C: an elapsed-time or unattended condition only a running system meets.
      /\b(within|after|for)\s+\d+\s*(minute|hour|day)s?\b/i.test(criterion) ||
      /\bno\s+(user\s+)?interaction\b/i.test(criterion);

    // ...unless the criterion names the in-repository artifact that satisfies
    // it. Every word here was added because it produced a false BLOCKING on a
    // live UAT ticket, and a gate with false positives gets disabled within a
    // day:
    //   CS-51 AC4  "browser assertions ... demonstrated failing before passing"
    //   CS-23 AC3  "proven by pointing a provider at a FIXTURE"
    //   CS-34 AC2  "verify with SYNTHETIC configuration"
    //   CS-49 AC5  "verified in all three BROWSER ENGINES at 320, 768 and 1440"
    // `shown` was also dropped as a trigger outright: CS-18's "per-dimension
    // contributions SHOWN" means displayed in a UI, not demonstrated on a host.
    const satisfiedInRepository =
      /\b(test|tests|assertion|assertions|suite|vitest|playwright|unit|fixture|fixtures|synthetic|mock|mocked|stub|stubbed|harness|browser|browsers|engine|engines|renderer|mutation|typecheck|compile)\b/i.test(
        criterion,
      );

    if (demandsDemonstration && !satisfiedInRepository) {
      // P-5: Shape 3's comment is the standard — "prose about CI is not a CI
      // result; only something a real run produces can stand for one" — and
      // this suppressor did not apply it. Topic words are not evidence: the
      // first attempt accepted `\bssh\b`, and CS-30's "OPERATOR RUNBOOK READY
      // 2026-09-25 ... contains the exact commands" suppressed its own finding,
      // because a ticket about SSH naturally says SSH. A runbook that is ready
      // is not a run.
      //
      // So every marker below names an ACTION TAKEN, not a subject discussed,
      // and must be accompanied by a date.
      const dated = /\b20\d\d-\d\d-\d\d\b/;
      const externallyPerformed =
        /actions\/runs\/\d+|\boperator\s+(ran|executed|performed|confirmed|observed)\b|\b(ran|executed|performed|observed)\b[^.]{0,40}\bon the (host|VPS|server|origin)\b|\bssh\s+\S+@/i;
      const demonstrated = claims.some(
        ({ text }) => externallyPerformed.test(text) && dated.test(text),
      );
      if (!demonstrated) {
        findings.push({
          ticket: ticket.id,
          shape: 'real-system-demonstration-missing',
          severity: 'blocking',
          field: name,
          detail:
            `${name} can only be satisfied by observing a running system, and no evidence entry ` +
            'records a dated action performed on one. A runbook that is ready is not a run, naming a ' +
            'script is not executing it, and unit tests of the logic are not the demonstration asked for.',
          quote: criterion.slice(0, 200),
        });
      }
    }
  });

  return findings;
}

/** Reads the inputs, failing loudly rather than degrading to an empty result. */
export function loadContext(root) {
  const backlogPath = join(root, '.ai', 'backlog.json');
  let raw;
  try {
    raw = readFileSync(backlogPath, 'utf8');
  } catch (error) {
    throw new CannotLook(`Could not read ${backlogPath} (${error.message}).`);
  }
  let backlog;
  try {
    backlog = JSON.parse(raw);
  } catch (error) {
    throw new CannotLook(`${backlogPath} did not parse (${error.message}).`);
  }
  if (!Array.isArray(backlog.items)) {
    throw new CannotLook(`${backlogPath} has no "items" array.`);
  }
  if (backlog.items.length < 10) {
    throw new CannotLook(
      `${backlogPath} holds only ${backlog.items.length} item(s), which cannot be the real board.`,
    );
  }

  const limitationsPath = join(root, 'docs', 'KNOWN-LIMITATIONS.md');
  let markdown;
  try {
    markdown = readFileSync(limitationsPath, 'utf8');
  } catch (error) {
    throw new CannotLook(`Could not read ${limitationsPath} (${error.message}).`);
  }
  return { items: backlog.items, limitations: parseLimitations(markdown) };
}

function report(findings, { strict, scope, context }) {
  const blocking = findings.filter((finding) => finding.severity === 'blocking');
  const advisory = findings.filter((finding) => finding.severity === 'advisory');

  for (const finding of [...blocking, ...advisory]) {
    const marker = finding.severity === 'blocking' ? 'BLOCKING' : 'ADVISORY';
    warn(`  ${marker}  ${finding.ticket}  ${finding.shape}`);
    warn(`            ${finding.detail}`);
    if (finding.quote) warn(`            > ${finding.quote}`);
  }

  write(
    `\n${scope} — ${blocking.length} blocking, ${advisory.length} advisory finding(s) across ${
      findings.length
    } total`,
  );

  // P-3: the one input this check trusts completely. It refuses to take a
  // ticket's word about itself, then accepts docs/KNOWN-LIMITATIONS.md's
  // self-declared status without qualification — and a section relabelled from
  // `OPEN` to `DEFERRED` silently converts every criterion that cross-references
  // it from blocking to advisory. The register is editable by the same session
  // whose ticket is being judged, and nothing requires a DEFERRED section to
  // carry a ticket id, a date or an owner.
  //
  // Policing the register would be the expensive fix and would still not stop a
  // determined edit. Printing the number is cheap and makes the lever visible:
  // the count moves when someone pulls it, whether or not anyone is watching
  // that commit.
  const deferred = context.limitations.filter((section) => section.deferred);
  write(
    `      limitations register: ${context.limitations.length} section(s), ` +
      `${context.limitations.filter((s) => s.open).length} OPEN (blocking), ` +
      `${deferred.length} DEFERRED/PARTIAL (downgraded to advisory)`,
  );
  if (deferred.length > 0) {
    write(`      downgrading sections: ${deferred.map((s) => s.heading).join('; ')}`);
  }

  if (blocking.length > 0 && strict) {
    warn(
      '\n::error::A ticket cannot be promoted while an acceptance criterion is contradicted by its own record.',
    );
    return 1;
  }
  if (blocking.length > 0) {
    write(
      'Advisory mode: these do NOT fail the build yet. Re-run with --strict once the shapes have\n' +
        'proven themselves, and have release:promote adopt --strict at that point.',
    );
  }
  return 0;
}

function main() {
  const rootArgument = process.argv.find((argument) => argument.startsWith('--root='));
  const root = rootArgument
    ? rootArgument.slice('--root='.length)
    : fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
  const strict = process.argv.includes('--strict');
  const only = process.argv.find((argument) => argument.startsWith('--tickets='));

  const context = loadContext(root);
  let selected;
  let scope;
  if (only) {
    const wanted = only
      .slice('--tickets='.length)
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    selected = context.items.filter((ticket) => wanted.includes(ticket.id));
    const missing = wanted.filter((id) => !selected.some((ticket) => ticket.id === id));
    if (missing.length > 0) {
      throw new CannotLook(`Requested ticket(s) not on the board: ${missing.join(', ')}`);
    }
    scope = `${selected.length} named ticket(s)`;
  } else {
    selected = context.items.filter((ticket) => ticket.status === 'UAT');
    // An empty selection is a broken read, not a clean board. A sibling review
    // found a loop iterating an empty array with every assertion running zero
    // times; this is the same shape and must fail.
    if (selected.length === 0) {
      throw new CannotLook(
        'No tickets are in UAT. With 20+ normally awaiting acceptance, zero means the read broke ' +
          'rather than that the board is clean.',
      );
    }
    scope = `${selected.length} UAT ticket(s)`;
  }

  const findings = selected.flatMap((ticket) => assess(ticket, context));
  if (findings.length === 0) {
    write(`PASS  ${scope} — no acceptance criterion is contradicted by its own record`);
    // Printed on the clean path too: a register-wide OPEN->DEFERRED edit would
    // most likely produce exactly this clean path, so this is the run where the
    // number most needs to be visible.
    const deferred = context.limitations.filter((section) => section.deferred);
    write(
      `      limitations register: ${context.limitations.length} section(s), ` +
        `${context.limitations.filter((s) => s.open).length} OPEN (blocking), ` +
        `${deferred.length} DEFERRED/PARTIAL (downgraded to advisory)`,
    );
    return 0;
  }
  warn(`\nPromotion evidence findings:\n`);
  return report(findings, { strict, scope, context });
}

// Only run when invoked directly, so the detector can be tested without the CLI.
if (
  process.argv[1] &&
  import.meta.url ===
    new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href.replace('file:////', 'file:///')
) {
  try {
    process.exitCode = main();
  } catch (error) {
    if (error instanceof CannotLook) {
      warn(`::error::${error.message} Refusing to report "no problems found" when unable to look.`);
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}
