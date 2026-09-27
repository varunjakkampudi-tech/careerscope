# Operator action required — `.github/agents/careerscope-orchestrator.agent.md`

**Ticket:** CS-10 · **Raised:** 2026-09-24 · **Severity:** P1
**Status:** PROPOSED — not applied. Requires an operator to apply and commit.

## Why this is a proposal and not a change

No agent in this system may edit anything under `.github/agents/`. That is not
a process nicety; it is the mechanism every other guarantee rests on. Each
read-only reviewer is read-only because its agent file grants it no `edit`
tool. An agent able to edit agent files could grant itself, or another agent,
that tool in a single write — and the permission model would be gone with
nothing to detect it.

So the Orchestrator does not self-edit this file **even to remove a
contradiction that misroutes the Orchestrator itself**. A forensic audit
explicitly upheld that refusal. What follows is a precise, reviewable diff for
an operator to apply in a normal reviewed commit.

All four defects were confirmed against current bytes by a read-only Agent
Operations dispatch and re-confirmed independently by the forensic audit.

---

## D-1 (P1) — the activation table is duplicated, and the two copies contradict

The canonical table lives in `.ai/AGENT-SETUP.md`. A second copy lives here at
**lines 63–72**. Six rows agree; two do not. The worst is the last row.

`.ai/AGENT-SETUP.md` also states the governing rule: _"Activate per task —
never 'run all agents'."_ Line 72 of this file says the opposite. **The
Orchestrator reads its own file, so the contradicting copy is the one that
actually gets obeyed.**

This is the Code Quality failure mode exactly: two implementations of one idea,
one of which drifts — and it already has.

### Proposed change — replace lines 61–76 with a pointer

Delete the whole table (lines 63–72) and the two sentences around it, and
replace with:

```markdown
Invoking all 24 agents for a CSS fix is not rigour, it is theatre — and it
trains everyone to skim the output. Match the team to the risk.

**The activation policy is defined in one place: the "Routing — smallest
sufficient team" section of `.ai/AGENT-SETUP.md`.** It covers all 24 agents,
the change classes this project actually has, and the disambiguation rules for
the six overlapping pairs. Read it there.

It is deliberately NOT duplicated here. A second copy existed until 2026-09-24
and had already drifted into contradicting the canonical one (CS-10, D-1),
including a "System redesign → all" row that violates this project's own
"activate per task — never run all agents" rule.

Add Performance when the change touches a hot path, a query, bundle size or
worker throughput. Always add the Final Auditor when the change ships.
```

**Do not** simply correct the `all` row and keep the duplicate. Two copies of a
routing policy will drift again; the fix is that there is one copy.

---

## D-2 (minor) — stale roster count

**Line 60** reads:

> Invoking all **ten** agents for a CSS fix is not rigour, it is theatre

The roster is **24**. `.ai/AGENT-SETUP.md` already says "all 24 agents" in the
equivalent sentence. The replacement text in D-1 above already corrects this;
if D-1 is applied, D-2 needs no separate change.

---

## D-7 (P1) — the fallback ladder contradicts the roles-are-distinct rationale

**Lines 189–190:**

```
| System Designer                     | Product Architect                                         |
| Product Architect                   | System Designer                                           |
```

These make the two roles mutual fallbacks. But `.ai/AGENT-SETUP.md` defends
them as _not_ duplicates — "one asks whether the model is right, the other
whether the structure is". A role that can substitute for another on failure is
being treated as interchangeable with it. **Both cannot be true.**

This is the strongest available argument for merging the pair, and it comes
from the Orchestrator's own file.

### Proposed change — pick one and say so

Preferred (keeps both roles, removes the contradiction):

```
| System Designer                     | none — re-brief and retry, then BLOCKED. Its question (is the structure and failure mode right) is not the Product Architect's question (is the domain model right), so substituting produces a different review, not the same one. |
| Product Architect                   | none — re-brief and retry, then BLOCKED. See above.                                                                                                                                                                                  |
```

The alternative is to accept that they are interchangeable and merge them, and
amend `.ai/AGENT-SETUP.md` to stop claiming they are distinct. **Either is
defensible. The current state — claiming distinct while treating them as
substitutes — is not.**

---

## D-8 (P1) — the Independent Reviewer's fallback spends the last independent check

**Line 191:**

```
| Independent Reviewer                | Final Auditor                                             |
```

The Final Auditor is given **no fallback**, deliberately, because it is the
final independent check and substituting an agent that already saw the work
destroys the only independence in the loop. This row spends exactly that agent
mid-loop. After it has served as the Independent Reviewer's stand-in, nothing
fresh remains for `FINAL_AUDIT` — yet the result can still be presented as
having passed final audit.

That is why this is P1 rather than cosmetic: **no data or security impact, but
it is an integrity risk to every verdict this system produces.**

### Proposed change

```
| Independent Reviewer                | Code Quality and Security in combination, or BLOCKED — never the Final Auditor, whose independence must remain unspent for FINAL_AUDIT |
```

---

## Verification after applying

```
node scripts/check-agents.mjs     # must stay "agent configuration valid", 24 of 24
npm run format:check
npm run eol:check
```

Then confirm by reading that `.ai/AGENT-SETUP.md` is the only place an
activation table exists:

```
grep -rn "System redesign" .github/agents/ .ai/
```

Expected after the fix: matches in `.ai/AGENT-SETUP.md` only.
