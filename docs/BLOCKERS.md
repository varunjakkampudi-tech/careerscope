# Blockers

Each blocker names what cannot be finished here, who must act, and which stage it affects. Nothing in
this file is a claim that an item passed.

| ID   | Blocker                                    | Affects    | Owner action                                                                                                              |
| ---- | ------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------- |
| B-04 | Prompt-scoped full file audit              | Stage 01   | Engineering: account for all 478 tracked files, complete the 1.01/1.10 review, fix confirmed defects, and record evidence |
| B-03 | Enabling new-user registration (item 2.09) | Deployment | The owners approve the legal text and its public HTTPS URLs; then set `REGISTRATION_ENABLED=true` at deploy time          |

Resolved in stage 02: the Resend domain (item 2.20) is Verified in the dashboard, and a live notice
reached Delivered status. The owner checked the notice in Gmail: it sits in the inbox, not the spam
folder. The lost-email recovery policy (item 2.17) was decided and built. B-02 (second email provider)
was decided by the owners: not in stage 02. The decisions are in [GAP-MATRIX](GAP-MATRIX.md).

## B-04 details

- **Affected requirement:** Stage 01 master-prompt items 1.01 and 1.10.
- **Severity:** High for the prompt's completion gate; no production defect is implied.
- **Reproduction:** Compare the prompt's requirement to review every tracked file with the available audit evidence. The enforced thirteen-item register and current targeted reviews do not prove an exhaustive file-by-file review of the 478 tracked files.
- **Root cause:** The repository's existing Stage 01 register has thirteen differently numbered items and does not include a file-level audit record for the separate fifteen-item prompt.
- **Attempted resolution:** Added an explicit prompt-to-register crosswalk and obtained separate targeted API/security, data/worker, frontend and critical-review passes. These do not yet establish every-file coverage.
- **Current state:** Open. No full repository review is claimed.
- **Engineering resolution:** Complete the file-accounted review, resolve confirmed Stage 01 findings, and record file coverage and tests in the canonical docs.
- **Test evidence:** On 2026-11-02, `npm run gates:test` passed with 313 unit tests passing, 3 skipped and 0 failing; its nested `deploy:gate:test` passed all 11 Node tests and the gate policy assertions, including partial-dispatch and timestamp-ordering cases. Hosted exact-SHA evidence is recorded in the Stage 01 completion report.
- **External dependency:** None.
- **Next action:** Complete the file-accounted audit and resolve any confirmed findings; rerun applicable gates for any resulting changes.
