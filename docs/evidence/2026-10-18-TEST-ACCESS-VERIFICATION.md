# Private test-access cleanup verification

Local verification performed on 2026-10-18. This is not hosted CI or production
acceptance. GitHub Actions remain disabled by owner request.

## Changes verified

- Removed active cloud identity and cloud queue integration; persistent private
  Redis now carries queue commands. Existing database fencing owns effects.
- Preserved deterministic matching, encrypted file storage, ownership, CSRF,
  opaque sessions, historical migrations and approved design assets.
- Added the two explicit test identities from the server-owned registry.
  Hosted access requires HTTPS, the proxy password and a private assertion.
- Retained password-account library regression coverage without exposing signup
  or password changes through the executable test-access API.
- Preserved the owner's AI-provider removal and corrected stale UI/contracts.
- Fixed invalid Docker ignore rules, proxy module imports/authentication support,
  and runtime pruning of required platform-native optional dependencies.
- Made sidebar links explicitly keyboard reachable in Windows WebKit without
  weakening the navigation-order assertion.

## Executed evidence

| Check                                                                            | Result                                                                                                         |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `npm run gates:test`                                                             | PASS; Node/deployment/privacy/EOL checks, lint, typecheck and 42 unit tests                                    |
| `npm run test:domain`                                                            | PASS; 830 tests across 29 files                                                                                |
| `npm run test:integration`                                                       | PASS; 48 tests against isolated PostgreSQL/Redis                                                               |
| Queue regression file after adding DLQ coverage                                  | PASS; 3 tests including stale receipt refusal and every failed command observable                              |
| Historical migration upgrade/idempotency test after restoring its fixture        | PASS; targeted partial-search integration test                                                                 |
| `scripts/check-database-recovery.ts`                                             | PASS; 14 table fingerprints and encrypted file recovery compared using synthetic data                          |
| `scripts/check-queue-runtime.ts`                                                 | PASS; isolated Redis restart, AOF restore and real process lifecycle                                           |
| `npm run test:ui` equivalent with isolated service environment                   | PASS; Chromium/Firefox/WebKit, existing workspace regressions and real test selection, keyboard/reflow and axe |
| `npm run build`                                                                  | PASS; two-pass production CSP verification                                                                     |
| `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run eol:check` | PASS                                                                                                           |
| `npm run security:check`                                                         | PASS at configured high-severity production threshold; unresolved moderate findings remain                     |
| Production and acceptance Compose configuration                                  | PASS with synthetic environment only                                                                           |
| Production namespace/publication/secret-consumer assertions                      | PASS; only network-anchor publishes ports, no staging secrets in web/workers                                   |
| Rebuilt proxy image and production Caddy validation                              | PASS; HTTP Basic module present                                                                                |
| Changed shell scripts `bash -n`, `git diff --check`                              | PASS                                                                                                           |

An initial restore invocation selected the default container name, which was not
present. The successful invocation explicitly selected this session's isolated
PostgreSQL container. Browser failures exposed a stale preparation caption and
Windows WebKit's default omission of links during Tab traversal; both were
corrected and the complete browser suite rerun successfully. No retries/skips or
weakened assertions were added to hide these failures.

## Explicit limits

The fresh runtime image also built successfully. Its restricted network-free
smoke passed native password hashing and core/provider/matching package imports.

The production dependency audit reports three moderate entries in the DOCX
parser chain. The development dependency audit has additional lint/schema-tool
findings, including five high entries; see SECURITY.md. No breaking downgrade
was applied automatically.

No live staging password, DNS, TLS, firewall or hosted account acceptance was
performed. The new operator smoke script was syntax-checked, not executed
against a live host. No production data, real credentials or environment files
were modified. The admin selector labels an isolated test workspace, not a
completed privileged admin control plane. No production deployment is certified.
