# scripts

Repository tooling, grouped by who runs it. Tests sit beside the script they test.

| Folder   | Contents                                                                                                                                        | Used by                                                                |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `ci/`    | Gates and policy checks: line endings, privacy, Node version, deploy gate, CI success, test types, clean-dist, dependency remediation           | `npm run check`, CI                                                    |
| `jobs/`  | Production jobs: `migrate`, `setup-owner`, scheduled discovery, lead liveness, search retention, job-sightings backfill, notification lifecycle | The runtime image (`/app/scripts/jobs`), systemd units, `npm run db:*` |
| `tests/` | End-to-end and verification harnesses: UI, visual regression, performance, soak, crash and database recovery, queue runtime                     | `npm run test:*`                                                       |
| `dev/`   | Local developer setup (`setup-local.mjs`)                                                                                                       | `npm run setup:local`                                                  |

Scripts here import from the repository root, so a file one level down uses
`../../packages/...` and `../../migrations`. The Dockerfile copies only the
`jobs/` entry points the image runs.
