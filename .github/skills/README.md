# Project-Local Agent Skills

Skills installed here are available to coding agents working in this repository.
They are project-scoped on purpose: CareerScope-specific knowledge should not
leak into unrelated workspaces, and a new contributor should get the same
assistance without any personal setup.

## Source and pinning

| Field      | Value                                      |
| ---------- | ------------------------------------------ |
| Catalog    | `sickn33/agentic-awesome-skills`           |
| Pinned tag | `v17.5.0`                                  |
| Commit     | `ebffb8789f6f36047ba76ed7233380b4d837d371` |

Skills are **not** verified by GitHub. Every skill below was read in full before
installation and checked for embedded scripts, remote script execution and
destructive commands. None of the installed skills contain executable files.

### Reinstalling reproducibly

`gh skill install <repo> <path>` resolves skills through the GitHub contents
API, which truncates a directory listing at 1000 entries. This catalog has more
than 2000 skills, so its listing stops at `implement` and every skill sorting
after that is reported as "not found". Install from a pinned local clone
instead:

```sh
git clone --depth 1 --branch v17.5.0 --filter=blob:none --sparse \
  https://github.com/sickn33/agentic-awesome-skills.git /tmp/aas
cd /tmp/aas && git sparse-checkout set skills && cd -

gh skill install /tmp/aas <skill-id> --from-local \
  --agent github-copilot --dir .github/skills
```

## Installed

| Skill                          | Why it was selected                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `react-best-practices`         | The web tier is React 19 on Next.js 16. Vercel-maintained, 73 KB including 80 rule files.                                            |
| `postgres-best-practices`      | PostgreSQL is the source of truth for runs, outbox, leads, profiles and resume metadata. Supabase-maintained.                        |
| `drizzle-orm-expert`           | Schema and migrations are Drizzle; `v2/migrations` is generated from it.                                                             |
| `accesslint-audit`             | WCAG 2.2 report/fix modes. Accessibility is an open sign-off gate and axe alone is not sufficient.                                   |
| `nextjs-seo-indexing`          | Canonical, robots and indexing behaviour for a Next.js app, where the deployed workspace must stay unindexed.                        |
| `container-security-hardening` | The stack ships as hardened containers: read-only rootfs, dropped capabilities, non-root users, pinned digests.                      |
| `phase-gated-debugging`        | Forbids editing source until a root cause is reproduced and confirmed. Directly supports the "no fix claimed without evidence" rule. |
| `audit-skills`                 | Static analysis for vetting future skills. Required by the skill-management rule below.                                              |

## Rejected, with reasons

Rejection matters as much as selection. These were previewed and refused:

| Skill                                                                                  | Reason                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codebase-audit-pre-push`                                                              | Instructs immediate deletion of `test-results/` and `*_backup.*`. This repository tracks `test-results/pages-baseline/` as the UI comparison baseline and keeps `data/session-backups/`. It would destroy verification evidence. |
| `api-security-testing`                                                                 | A bug-bounty workflow that chains into `api-fuzzing-bug-bounty` and `scanning-tools`. Fuzzing a live production origin is out of scope and the dependencies are unvetted.                                                        |
| `file-uploads`                                                                         | Teaches S3, R2 and presigned URLs. Resume storage is deliberately an encrypted private filesystem with a single writer; the S3 adapter was removed. This would push an architecture that was explicitly abandoned.               |
| `nextjs-app-router-patterns`, `javascript-testing-patterns`, `error-handling-patterns` | Content-free stubs: a restated description, a "use when" list and an empty `resources/` directory.                                                                                                                               |
| `saas-multi-tenant`                                                                    | CareerScope is single-owner. Multi-tenant row-level security is not the model.                                                                                                                                                   |
| `bullmq-specialist`                                                                    | `QUEUE_TRANSPORT=bullmq` covers the search queue only; resume parsing always uses the loopback SQS endpoint. Installing this would encourage a partially supported path.                                                         |
| AWS skills, offensive-security and reverse-engineering skills                          | No AWS in the deployed stack, and offensive tooling has no authorized target here.                                                                                                                                               |
| The AI/agent-memory/RAG category                                                       | AI inference is off by design and must not gain authority over deterministic matching or application submission.                                                                                                                 |

The catalog contains 2126 skills, of which **1102 are marked `risk: critical`**
and **61 `offensive`**. Installing it wholesale would be reckless. Only entries
marked `safe` or `none` were considered.

## Adding a skill later

1. Search the catalog and pick the smallest skill that covers the gap.
2. Preview it and read `SKILL.md` and any referenced resources in full.
3. Check for scripts, remote execution, and destructive commands. Use
   `audit-skills` for the static pass.
4. Reject anything that conflicts with the architecture or security rules in
   `.github/copilot-instructions.md`.
5. Install project-scoped into this directory, pinned to a tag.
6. Add it to the table above with the reason it was needed.

Do not install a skill because its name sounds relevant, and do not install the
catalog wholesale.
