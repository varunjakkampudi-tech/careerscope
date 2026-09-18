---
name: careerscope-deployment
description: 'The deployed single-host topology, provisioning, TLS and certificate handling, and the live verification scripts. Use when changing infra/v3, compose files, the Caddyfile, the Dockerfile, or anything affecting the deployed origin.'
---

# CareerScope Deployment

## Purpose

CareerScope runs on one Ubuntu host behind Caddy at `https://careerscope.tech`.
The topology is small on purpose. Several of the rules below exist because
breaking them caused a real outage or a real certificate-quota risk during
bring-up.

## When to use

- Changing anything under `infra/v3`
- Changing the Dockerfile, compose files or the Caddyfile
- Changing firewall, DNS or TLS configuration
- Verifying a change against the live origin

## Topology

| Item            | Value                                                |
| --------------- | ---------------------------------------------------- |
| Host            | Hostinger VPS, Ubuntu 24.04, 2 vCPU, 8 GB, 100 GB    |
| Proxy           | Caddy, built from source on a current Go toolchain   |
| Published ports | 80, 443 only                                         |
| Firewall        | nftables, `policy drop` on input, allowing 22/80/443 |
| Certificate     | Let's Encrypt via HTTP-01, renewed automatically     |

Only the proxy publishes ports. Every other service uses
`network_mode: service:proxy` and binds loopback, so Postgres, Redis, the queue,
the API and the web server have no externally reachable address.

## Files

| File                             | Role                                                          |
| -------------------------------- | ------------------------------------------------------------- |
| `provision-host.sh`              | Docker, unattended upgrades, nftables. Idempotent.            |
| `Dockerfile`                     | Multi-stage: `caddy-build`, `proxy`, `build`, `runtime`       |
| `compose.production.yml`         | Deployed topology                                             |
| `compose.acceptance.yml`         | Local acceptance stack                                        |
| `Caddyfile.production`           | Env-driven TLS, headers, Host guard                           |
| `deploy.sh`                      | Generates the database password on the host, starts the stack |
| `check-live-origin.sh`           | Cookie attributes, CSRF, forwarded headers                    |
| `check-live-flow.mjs`            | Full workspace flow against the live origin                   |
| `purge-verification-accounts.sh` | Removes throwaway `verify-*` accounts                         |

## Hard-won rules

- **Never use `flush ruleset` in the nftables config.** It deletes the rules
  Docker installs and silently breaks container egress; builds then fail with
  opaque `apt` timeouts. Replace only the project's own table and assert
  container egress afterwards.
- **Certificates must live on a persistent volume.** The acceptance compose puts
  Caddy's `/data` on tmpfs; production must not, or every restart re-requests a
  certificate and burns issuance quota. Verify with zero `obtain` log lines after
  a restart.
- **`www` needs its own site block.** It resolves via DNS, so without a
  certificate the handshake simply fails instead of redirecting to the apex.
- **Shell scripts must be LF.** `.gitattributes` enforces it; a CRLF checkout
  fails on the host with `$'\r': command not found`.
- **Test with `internal` TLS first.** `deploy.sh <domain> internal` uses a
  self-signed certificate so the stack can be proven healthy before any ACME
  request is made.

## Deploy sequence

```sh
bash provision-host.sh
DOCKER_BUILDKIT=1 docker build -f infra/v3/Dockerfile --target runtime -t careerscope:v3 .
DOCKER_BUILDKIT=1 docker build -f infra/v3/Dockerfile --target proxy   -t careerscope:v3-proxy .
bash deploy.sh careerscope.tech operator@example.com
docker exec -it careerscope-api-1 node /app/v2/scripts/setup-owner.ts
```

## Verification

`check-live-flow.mjs` requires registration temporarily enabled:

```sh
REGISTRATION_ENABLED=true bash deploy.sh careerscope.tech <email>
docker run --rm --network container:careerscope-proxy-1 \
  -v /root/flow.mjs:/tmp/flow.mjs:ro node:26.8.1-bookworm-slim \
  node /tmp/flow.mjs https://careerscope.tech
bash purge-verification-accounts.sh
bash deploy.sh careerscope.tech <email>     # registration back off
```

Always purge and re-disable registration afterwards. The flow script creates
throwaway `verify-*` accounts and real rows; leaving them behind pollutes the
owner's data.

Recovery is expected to be automatic: a full `down`/`up` and a host reboot both
restore service with no manual step and no new certificate request.

## Forbidden shortcuts

- Publishing a backend port to the host "for debugging"
- Leaving public registration enabled
- Running verification scripts against the owner's real account
- Requesting certificates in a loop while debugging — use `internal`
- Provisioning extra infrastructure, changing DNS or widening exposure without
  explicit approval
