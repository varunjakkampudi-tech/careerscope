# infra

Deployment assets for the single-host stack. On the host the repository is
shipped to `/opt/careerscope`; the secret `infra/.env` stays at the top of this
folder, is never committed, and is preserved by `host/ship.sh`.

| Folder         | Contents                                                                               | Used by                                                      |
| -------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `docker/`      | `Dockerfile`, `Dockerfile.dockerignore`, `compose.*.yml`                               | `host/build-images.sh`, `host/deploy.sh`, `npm run services` |
| `caddy/`       | `Caddyfile` (acceptance) and `Caddyfile.production`                                    | Mounted into the proxy by the compose files                  |
| `systemd/`     | `careerscope-*.service` and `.timer` units                                             | Installed by the `host/setup-*.sh` scripts                   |
| `host/`        | Provisioning, deploy, monitoring, recovery and hardening scripts, plus `bootstrap.mjs` | The operator, over SSH, and the systemd timers               |
| `checks/`      | `check-*.sh` and `check-full-disk.mjs` verification scripts                            | Operators, CI and `npm run test:full-disk`                   |
| `maintenance/` | The static maintenance page                                                            | `host/maintenance.sh`, served by the proxy                   |

Notes:

- Compose build context is the repository root, so build from there:
  `docker build -f infra/docker/Dockerfile .`
- Compose files resolve mounts relative to `infra/docker/`; pass the secret file
  explicitly: `docker compose --env-file infra/.env -f infra/docker/compose.production.yml ...`
- `bootstrap.mjs` is bind-mounted by compose, not copied by the Dockerfile, so it
  lives in `host/`.
- Unit files keep their on-host paths (`/usr/local/bin/...`, `/opt/careerscope/...`);
  the container job paths are `/app/scripts/jobs/...`.
- `REDIS_PASSWORD` is required in production; see `docs/operations/SECRETS.md`.
