# START HERE

**You are an AI assistant, or a human, opening CareerScope for the first time on
this machine. Read this file completely before running or changing anything.**

Five minutes here will save you from the mistakes that have already cost this
project real outages.

---

## Read in this order

| #   | File                                           | Why                                                   |
| --- | ---------------------------------------------- | ----------------------------------------------------- |
| 1   | this file                                      | orientation and the rules that are not negotiable     |
| 2   | [01-SETUP.md](01-SETUP.md)                     | get the repository running on macOS, Linux or Windows |
| 3   | [02-PROJECT.md](02-PROJECT.md)                 | what CareerScope is, its features and its flows       |
| 4   | [03-MULTI-AGENT.md](03-MULTI-AGENT.md)         | the 16-agent engineering system and how to drive it   |
| 5   | [04-SESSION-RESTORE.md](04-SESSION-RESTORE.md) | restoring a prior chat session on a new machine       |
| 6   | [05-VERIFICATION.md](05-VERIFICATION.md)       | which command proves which claim                      |

Then the live state:

```bash
node scripts/control-center.mjs     # what the engineering system is doing
cat .ai/CAREERSCOPE-PROGRESS.md     # what is done, with evidence
tail -120 review.txt                # what the last cycle actually did
```

---

## What this project is, in one paragraph

CareerScope is a **single-owner** job-search platform. One user, no public
signup. It discovers postings from multiple sources, deduplicates them by
fingerprint, scores them deterministically against a frozen profile snapshot,
and tracks a saved-lead pipeline. It is deployed at **https://careerscope.tech**
on one VPS behind Caddy. There are two stacks in this repository: **V1** (legacy
Fastify + SQLite + React/Vite, the `main` line) and **V2** (current, `3.0.0`:
Fastify + PostgreSQL + Drizzle + Redis + SQS + Next.js/React 19). The V2 stack
is what is deployed.

## The things that are true and surprising

Most mistakes here come from assuming otherwise.

- **AI generation is OFF. Auto-apply is ON HOLD. Naukri is legitimate-access
  only.** These are deliberate product positions, not unfinished work.
- **The V2 frontend is one route.** An ~830-line `page.tsx` uses a `view` state
  variable to simulate navigation between pages that do not exist. The backend
  is mature; the product surface is not. This is the largest open gap.
- **`data/` is entirely gitignored** and holds the database, resumes and `.env`.
  Nothing in it survives a clone. It is not broken — it is private.
- **Local `HEAD` and the deployed revision are often legitimately different.**
  Confirm with `infra/v3/check-provenance.sh`; never assume.
- **The repository is public.** Never commit personal data, transcripts,
  databases, credentials or editor state.

## Five operational rules, each from a real incident

1. **Never run `nft flush ruleset`.** It deletes Docker's NAT rules and kills
   container egress. The symptom is an unrelated timeout, not a firewall error.
2. **Never restart the proxy alone.** Every service joins its network namespace;
   restarting it strands them all behind a 502 _while they still report
   healthy_. Use `infra/v3/restart-stack.sh`.
3. **Never run `docker system prune -a`.** It removes the images a rollback
   needs. Prune build cache only.
4. **Never regenerate `POSTGRES_PASSWORD`** against an existing database volume.
   The host's `infra/v3/.env` is the only copy.
5. **Never deploy uncommitted code.** Deploy from a reviewed commit, then prove
   it with `check-provenance.sh`.

## The engineering rule that matters most

> **A green check is not evidence until the check has been shown to go red.**

This project has shipped **four** checks that reported success while being
structurally incapable of detecting failure — a regex that matched only one YAML
style, an assertion that was true whenever a string was absent, a multiline
parse against a CRLF file, and a backup that copied the wrong directory and
exited 0 with a tidy summary.

So: when you add an important check, break the thing it protects, watch it fail,
restore it, watch it pass. Record all three. And:

> **Machine decisions consume structured state (`.ai/*.json`), never prose.**
> Markdown is the human projection.

Related, and just as load-bearing: a zero exit code proves nothing. On this
machine `claude auth status` exits **0** while reporting `loggedIn: false`.
Read the output.

## If you are an AI assistant

- The repository is the source of truth. Read code before trusting documentation.
- State assumptions. Prefer the smallest defensible change. Verify promptly.
- Report what you actually ran, with real totals — `1047 passed (1047)`, not
  "tests pass". A skipped test is not a passing test.
- Do not claim completion without evidence. Do not weaken a security control, a
  threshold or a test to get something green.
- Commit, push, deploy or install system software only when asked. **Pushing to
  `main` auto-deploys to production.**

Full contract: [`.github/copilot-instructions.md`](../.github/copilot-instructions.md).
