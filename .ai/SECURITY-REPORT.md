# CareerScope R1 Security & Privacy Review

Review baseline: canonical root workspace, 2026-10-01. This is an evidence-
backed source, configuration and local-test review; it is not live Hostinger,
AWS, container-image or network-penetration certification.

## Executive verdict

No locally evidenced P0/P1 defect or current tracked secret was found. The
repository privacy gate is enforced by CI. Release security remains **BLOCKED**
by external infrastructure validation, hosted service-backed isolation and
recovery evidence, manual screen-reader acceptance, and the owner-deferred
off-host backup decision.

## Control matrix

| Security area           | Status                | Evidence                                                                           | Residual risk                                            |
| ----------------------- | --------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Authentication          | PASS locally          | Opaque server sessions, Argon2id, rotation/revocation tests                        | Hosted Cognito callback/OTP configuration is external    |
| Authorization           | PASS locally          | Server-derived owner scope and cross-owner tests                                   | Hosted Postgres/Redis isolation evidence remains         |
| Sessions                | PASS locally          | HttpOnly/Secure/SameSite cookies, expiry and revocation                            | Live TLS/cookie acceptance is external                   |
| CSRF / Origin / CORS    | PASS locally          | Exact origin and CSRF checks in API tests                                          | Recheck on the live origin                               |
| Secrets                 | PASS current tree     | `npm run privacy:check`; `.env` ignored; no high-confidence current secret         | Immutable history has historical private-path names only |
| GitHub/Copilot/agents   | PASS locally          | `.github/AGENT-SECURITY.md`, common contract links, least-privilege grants         | Platform-side retention/permissions require owner review |
| PII                     | PASS current tree     | Synthetic fixtures and reserved domains; real resume contact replaced              | Public job-source data can contain company contacts      |
| Logging                 | PASS by source review | Fastify redaction excludes cookies, authorization, passwords and tokens            | Live retention/redaction needs host evidence             |
| Uploads/resumes         | PASS locally          | Bounded parsing, owner-scoped encrypted storage and cleanup tests                  | Hosted storage and restore proof remain                  |
| Database                | PASS locally          | Parameterized queries, owner predicates, append-only migrations                    | Hosted backup/restore and constraints remain             |
| SSRF                    | PASS locally          | URL validation, redirect restrictions and bounded responses                        | Provider behaviour can change                            |
| XSS / HTML              | PASS locally          | React escaping, sanitized provider HTML, no production raw HTML path               | Browser CSP acceptance is external                       |
| SQL / command injection | PASS locally          | Parameterized SQL and fixed child-process arguments                                | None known locally                                       |
| CSP / headers           | PASS locally          | Production CSP hash verification and Caddy headers                                 | Live proxy/TLS verification remains                      |
| Dependencies            | REVIEW                | Current lockfile audit is the release check; no blind major upgrades               | Exact-SHA audit/container scan required                  |
| CI/CD                   | PASS locally          | Privacy check runs before release gates; permissions read-only; action SHAs pinned | Hosted exact-SHA run required                            |
| Containers/network      | PASS configuration    | Compose/Caddy publish only the proxy; internal services isolated                   | Host firewall and image scan external                    |
| Encryption              | PASS by design        | Resume encryption and secret runbooks                                              | Key rotation and host custody external                   |
| Backups                 | PARTIAL               | Local backup/restore check exists and is CI-wired                                  | Off-host disaster recovery is OWNER-DEFERRED             |
| Incident/recovery       | PARTIAL               | Crash, queue, database and full-disk checks are wired                              | Live recovery/RTO acceptance external                    |

## Automated privacy gate

`scripts/check-privacy.mjs` scans Git-tracked paths only. It fails closed on
high-confidence private filenames, private artifact directories, private-key
headers, cloud/GitHub/provider tokens, JWTs and credential-bearing remote
database URLs. It reports category and path, never matched values. It also
detects obvious non-synthetic email/phone data outside approved fixture, seed,
documentation and infrastructure contexts.

```text
npm run privacy:test  PASS (3 tests)
npm run privacy:check PASS
```

`npm run privacy:check -- --history` performs a non-destructive historical
path scan. It found three historical private-path names (including retired
local tooling); no secret value was printed and no history rewrite was made.
If a live credential is ever confirmed, rotate it through the owner-approved
process rather than rewriting history or force-pushing.

## Agent permissions

The 24 repository agents are covered by the shared contract. Read-only roles
(Security, UX, Architecture, Research, QA and audit roles) have no `edit`
tool in their frontmatter. Builders and release/repository roles have edit or
execute only where their responsibility requires it; no agent has a general
secret store or deployment authorization. The contract forbids prompt
injection from resumes/provider content, data copying into `.ai` or reports,
permission expansion and security-control bypasses.

## Findings

- **P0:** none locally evidenced.
- **P1:** none locally evidenced in the current tree. Hosted service-backed
  authorization/recovery and live deployment checks remain required.
- **P2:** owner-deferred off-host backup; live Hostinger firewall/TLS and hosted
  recovery; manual screen-reader smoke test; historical private path names.
- **P3:** dependency/container/runtime assurance must be refreshed on the exact
  release commit. Theoretical concerns without a reachable path are not defects.

## Data handling limitations

The privacy gate is a guardrail, not proof that external systems contain no
private data. Production logs, Hostinger storage, AWS/Cognito, GitHub issue/PR
retention and provider responses require owner-authorized review. Local backups
do not provide VPS-loss recovery. See [docs/PRIVACY.md](../docs/PRIVACY.md),
[docs/SECURITY.md](../docs/SECURITY.md) and
[docs/OPERATIONS/SECRETS.md](../docs/OPERATIONS/SECRETS.md).

**Final security engineering gate: BLOCKED** — no local P0/P1 remains, but
external and owner/human acceptance is outstanding.
