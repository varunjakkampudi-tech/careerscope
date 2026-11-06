# Toolchain validation

`npm run toolchain:check` (`scripts/ci/check-toolchain.mjs`) runs in the CI
`Quality gates` job. Node 24 is the required version for CI, supported local work and the
production image. It fails when:

- `.nvmrc` or a workflow `NODE_VERSION` pin has a different major from the
  `engines.node` floor in `package.json` (currently `>=24`).
- The Dockerfile Node base image major is below that floor, or differs from `.nvmrc`.
  This is a failure, not a warning.
- The `next` or `fastify` major differs between workspaces, or differs from the
  major resolved in `package-lock.json`; `eslint-config-next` differs from `next`;
  or a locked `next`/`fastify` declares a Node engine above the floor.

## Validation recorded 2026-11-06 (Stage 01 item 1.03)

| Item              | Verified value                                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------------- |
| Runtime           | Node `24.22.1`; npm `11.19.1`                                                                                  |
| Docker image      | `node:24.22.1-bookworm-slim`, digest `sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c` |
| `engines.node`    | `>=24`                                                                                                         |
| `.nvmrc`          | `24`                                                                                                           |
| CI `NODE_VERSION` | `24`                                                                                                           |
| Next.js           | `16.4.5`; `eslint-config-next` also `16.4.5`                                                                   |
| Fastify           | declared `^5.12.8`, locked `5.12.8`                                                                            |

The workstation's default Node is `22.23.2`, below the project floor. Validation therefore
used the pinned Node 24 Docker image. A clean `npm ci` succeeded in an isolated source copy
without `.env` files. npm 11 reported that five dependency install scripts were not covered by
its `allowScripts` policy; the install completed, and the production build and unit tests passed
with the installed optional binaries.

### Framework patch review

The Next.js lock was upgraded from `16.4.3` to `16.4.5`, with
`eslint-config-next` kept on the matching version. Next.js `16.4.5` fixes seven moderate
security advisories published on November 3, including cross-tenant cache disclosure and
self-hosted response injection ([upstream release](https://github.com/vercel/next.js/releases/tag/v16.4.5)).
The installed `16.4.3` was in the affected range for multiple advisories.

Fastify was upgraded from `5.12.7` to `5.12.8`. The upstream advisory marks versions
`>=5.8.0, <5.12.8` affected by a moderate denial of service when a timed-out streaming
response has already sent headers ([GHSA-3qgw-9275-xf8w](https://github.com/fastify/fastify/security/advisories/GHSA-3qgw-9275-xf8w)).
The default `handlerTimeout: 0` is not affected, but the patched version removes reliance on
that workaround.

`npm audit --omit=dev` and the full `npm audit` both reported zero vulnerabilities before and
after these updates. The npm audit result did not include the newly published upstream
framework advisories; the release and security-advisory review caught them. CI continues to run
both audit commands with `--audit-level=high`.

### Verification on the patched lockfile

- `npm ci` — passed in a clean Node 24.22.1 container.
- `npm run node:check`, `npm run toolchain:check`, and `npm ls --depth=0` — passed.
- `npm run build` — passed, including both Next.js production builds and CSP hash verification.
- `npm run typecheck` — passed, including all 96 canonical test files.
- `npm run lint` — zero errors; three existing `no-console` warnings in `scripts/ci/check-file-audit.mjs`.
- `npm run test:unit` — 350 passed, 0 failed, 0 skipped in the container's Linux filesystem.
- `npm run test:domain` — 909 passed across 33 files.
- `npm audit --omit=dev --audit-level=high` and `npm audit --audit-level=high` — passed, zero vulnerabilities.
- `npm outdated --long` still reports newer compatible patch/minor releases and major-version upgrades. Those were not bulk-updated in this item; review them with their own compatibility evidence. Major holds include ESLint 10, TypeScript 7, and BullMQ 6.

The host's Node 22 runtime is unsupported. The local Docker bind mount also made subprocess tests exceed their timeouts; the same full unit suite passed from the container's Linux filesystem. The exact-commit GitHub CI run remains the final integration and browser gate for this checklist item.
