# Toolchain validation

`npm run toolchain:check` (`scripts/ci/check-toolchain.mjs`) runs in the CI
`Quality gates` job. It fails when:

- `.nvmrc` or a workflow `NODE_VERSION` pin has a different major from the
  `engines.node` floor in `package.json` (currently `>=24`).
- The Dockerfile Node base image major is below that floor.
- The `next` or `fastify` major differs between workspaces, or differs from the
  major resolved in `package-lock.json`; `eslint-config-next` differs from `next`;
  or a locked `next`/`fastify` declares a Node engine above the floor.

`engines.node` is a floor, so the production image may run a newer major than
`.nvmrc` and CI. That difference is a warning. `--strict` turns it into a failure.

## Result recorded 2026-10-27 (Node v24.22.1)

| Item              | Value                                  |
| ----------------- | -------------------------------------- |
| `engines.node`    | `>=24`                                 |
| `.nvmrc`          | `24`                                   |
| CI `NODE_VERSION` | `24`                                   |
| Dockerfile image  | `node:26.8.1-bookworm-slim` (major 26) |
| Next.js           | declared `16.4.3`, locked `16.4.3`     |
| Fastify           | declared `^5.12.7`, locked `5.12.7`    |

Open finding: the production image runs Node 26 while tests, CI and `.nvmrc` run
Node 24. The check passes with a warning because 26 satisfies `>=24`. Tests have
not been run on Node 26. The Dockerfile and `infra/checks/check-full-disk.mjs`
pin the image, and `scripts/ci/check-deploy-gate.test.mjs` asserts it, so aligning
them is an infrastructure decision for the owner (move the image to Node 24, or
move `.nvmrc`, CI and `engines` to 26 after running the suites there).

## Dependency audit

`npm audit --omit=dev` and `npm audit` (full tree) both reported
`found 0 vulnerabilities`. No lockfile change was needed. CI runs both with
`--audit-level=high` as blocking steps, and `npm run security:check` runs the same two.

## `npm outdated --long` (2026-10-27)

No update was applied; none was required to close an advisory. Major versions
behind are listed first and are deliberate holds until reviewed.

| Package                     | Current | Latest | Note                                                                                                                                                                                                                                       |
| --------------------------- | ------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@anthropic-ai/sdk`         | 0.123.0 | 1.3.0  | major, `packages/matching`                                                                                                                                                                                                                 |
| `eslint`, `@eslint/js`      | 9.39.5  | 10.x   | major                                                                                                                                                                                                                                      |
| `typescript`                | 5.9.3   | 7.0.2  | major                                                                                                                                                                                                                                      |
| `@types/node`               | 24.19.2 | 26.6.5 | root; `apps/web` has 20.19.43                                                                                                                                                                                                              |
| `bullmq`                    | 5.81.5  | 6.5.0  | major, queue transport                                                                                                                                                                                                                     |
| `pixelmatch`                | 7.2.0   | 8.0.0  | major, visual tests                                                                                                                                                                                                                        |
| `react`, `react-dom`        | 19.2.8  | 19.3.1 | minor, pinned exactly with Next                                                                                                                                                                                                            |
| `@fastify/swagger`          | 9.8.1   | 9.9.2  | pinned deliberately (API-SURFACE)                                                                                                                                                                                                          |
| `@fastify/swagger-ui`       | 6.1.1   | 6.1.2  | pinned deliberately (API-SURFACE)                                                                                                                                                                                                          |
| Patch or minor within range | -       | -      | `@fastify/cookie`, `@fastify/helmet`, `@node-rs/argon2`, `@tanstack/react-query`, `axe-core`, `drizzle-orm`, `google-auth-library`, `lucide-react`, `pg`, `pino`, `playwright`, `prettier`, `redis`, `typescript-eslint`, `vite`, `vitest` |

Re-run `npm outdated --long` and `npm audit --omit=dev` before each release and
update this table.
