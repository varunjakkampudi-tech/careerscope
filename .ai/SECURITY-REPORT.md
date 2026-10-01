# Security report

Review scope: canonical root CareerScope workspace at `ba1ebbe` plus the
CI-stabilisation changes in this cycle. This is a source/configuration review
and local evidence pass; it is not a live Hostinger, AWS or network-penetration
assessment.

Adversarial findings. Evidence means a reachable path, not a concern.

| Severity | File / symbol                                              | Evidence                                                                                                                                               | Impact                                                              | Remediation                                                             | Status                     |
| -------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------- |
| P0/P1    | Authentication, sessions, CSRF, origin and ownership paths | `apps/api/src/app.ts`, `packages/core/src/auth.ts`, owner-scoped repository queries, domain authorization tests                                        | No reachable P0/P1 defect found in locally reviewable paths         | Keep regression and service-backed isolation tests in CI                | No open local P0/P1        |
| P0/P1    | CSP/XSS                                                    | Production build emits hash-based `script-src`; React escaping is used and no `dangerouslySetInnerHTML` path is present; CSP build verification passed | No locally evidenced script injection path                          | Maintain hash discovery/enforcement and re-run on every build           | No open local P0/P1        |
| P0/P1    | Upload/path traversal/parser isolation                     | Resume bytes are bounded, format-detected, parsed in a permission-scoped child, and encrypted storage is owner-scoped; isolated parser test passes     | Hostile documents are rejected without network/child-process access | Keep parser and storage tests; service-backed recovery remains required | No open local P0/P1        |
| P2       | Disaster recovery                                          | Off-host backup is explicitly owner-deferred; local backup/restore is not VPS-loss protection                                                          | Host loss can destroy local data and local backups                  | Owner must approve and validate encrypted off-host retention/restore    | Open — owner decision      |
| P2       | Live network exposure                                      | Caddy/Compose configuration limits published services; live Hostinger firewall was not reachable for this review                                       | Host firewall drift cannot be excluded locally                      | Perform documented Hostinger firewall validation                        | Open — external validation |
| P3       | Dependency/runtime assurance                               | `npm audit --omit=dev --audit-level=high` reports 0 vulnerabilities; container scan/live TLS were not run here                                         | Remaining assurance is environment-dependent                        | Run hosted/container/TLS checks before production certification         | Open — external evidence   |

A theoretical issue with no reachable path is P3 and must say so. Inflated
severity destroys the signal.

**Verdict:** No locally evidenced P0/P1 security defect. Release security
certification remains BLOCKED by live infrastructure validation, hosted
service-backed authorization/recovery evidence and the owner-deferred
off-host-backup decision.
