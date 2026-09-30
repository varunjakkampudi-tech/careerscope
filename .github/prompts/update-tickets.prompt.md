---
mode: agent
description: 'Daily ticket review: convene the relevant agents, update every ticket status from evidence, and add new work to the backlog.'
---

# Update Tickets

Run this once a day. It reviews **every** ticket in `.ai/backlog.json`, not only
the active ones, and records what was decided and why.

## 1. Establish state

```
git branch --show-current ; git rev-parse --short HEAD ; git status --porcelain
npm run tickets:update
```

`tickets:update` refuses a board it cannot read and names every ticket that is
malformed, undated, unowned or stale. Fix the board before discussing it. It
opens today's record at `.ai/tickets/<date>.json`; that file is where the
outcomes go.

## 2. Convene the smallest sufficient set of agents

Route by what the tickets actually need. Running all 24 is theatre.

| Agent                    | Contributes                                          |
| ------------------------ | ---------------------------------------------------- |
| **Product Discovery**    | Candidate new tickets, with evidence for each        |
| **Project Manager**      | Priority, acceptance criteria, scope, release target |
| **System Designer / UX** | Whether the shape of the work is still right         |
| Owning builder           | What is genuinely done vs in progress vs blocked     |
| **QA**                   | Which claims have a command and output behind them   |
| **Security**             | Whether any ticket weakens an existing control       |
| **Independent Reviewer** | Challenges any status that cannot be evidenced       |
| **Orchestrator**         | Records the outcome; owns the completion decision    |

Each agent contributes only from its own responsibility.

## 3. Rules for changing a ticket

- A status change needs evidence: a command and its output, a diff, or a
  deployment check. An opinion is not a status.
- `RELEASED` requires proof the change is deployed — `infra/check-provenance.sh`,
  not a merged branch.
- `BLOCKED` names the blocker and who or what unblocks it. Blocked is never a
  parking space for work nobody wants.
- Respect the WIP limit of 2. Do not start a ticket to make the board look busy.
- A carried ticket on its third week is sliced or dropped, not carried again.
- New tickets state the user problem, the evidence it exists, and acceptance
  criteria that can fail. No ticket is added because it sounds useful.
- Set `updatedAt` on anything you touch. Do not touch tickets you did not review.

## 4. Record and verify

Write one entry per ticket into `.ai/tickets/<date>.json` — `id`, `outcome`,
what changed, and the evidence — plus the participating agents, anything added
or dropped, and open risks. Then:

```
npm run tickets:verify
npm run agile:gate:test
```

`tickets:verify` refuses while any ticket has no recorded outcome, so a review
cannot be reported as done when it was not.

## 5. Report

State: tickets reviewed, what changed status and on what evidence, what was
added or dropped, what is blocked, and what remains unverified. Do not claim a
ticket is finished because it compiles.
