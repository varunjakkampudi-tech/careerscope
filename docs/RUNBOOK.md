# Runbook

Operating Job Radar on a server. Everything here has a command; nothing here
requires reading source.

Start with [Production readiness](PRODUCTION-READINESS.md) and
[owner login setup](AUTHENTICATION.md). Production uses single-origin HTTPS and
an existing owner account. The HTTP bootstrap site serves only ACME challenges;
all application routes return 503 until the TLS configuration is activated.

For Copilot-assisted applications with a remote browser, use the opt-in
[EC2 application runtime](EC2-APPLICATIONS.md). The default image is not the
complete application-agent runtime.

> **Runtime evidence:** the base API image and isolated local Compose stack have
> been built and exercised on ARM64 Docker Desktop. This does not validate the
> production nginx/TLS stack, browser-agent image, EC2, or unattended operations.
> Read [Local containers](#local-containers) for the tested development path and
> [Troubleshooting](#troubleshooting) before deploying elsewhere.

**Contents** — [Choosing a shape](#choosing-a-shape) · [EC2 first boot](#ec2-first-boot)
· [TLS](#tls) · [systemd instead of Docker](#systemd-instead-of-docker)
· [GitHub Pages](#github-pages) · [CI/CD](#cicd) · [Backup and restore](#backup-and-restore)
· [Logs](#logs) · [Routine operations](#routine-operations) · [Troubleshooting](#troubleshooting)

---

## Choosing a shape

For Android browsing and manual applications while keeping private data and
Copilot on the Mac, see the separate [mobile job-list export](MOBILE-PAGES.md).
It publishes only a public static snapshot, not the authenticated app below.

|                              | Single-origin EC2     | Pages + EC2                                                       |
| ---------------------------- | --------------------- | ----------------------------------------------------------------- |
| SPA served by                | the API, behind nginx | GitHub Pages                                                      |
| Origins                      | one                   | two                                                               |
| `CORS_ORIGINS`               | empty                 | `https://<owner>.github.io`                                       |
| `VITE_API_BASE_URL` at build | unset (same origin)   | the API's public origin                                           |
| Needs a domain + TLS         | yes                   | yes — the browser refuses `http://` calls from an `https://` page |

**Use single-origin for owner login.** The Pages split-origin instructions below
are legacy API-key deployment guidance, not a supported configuration for
SameSite=Strict login cookies. The API needs a real hostname and certificate.

Do not run the compose stack and the systemd unit on the same box. They fight
over port 80 and over the same database file.

### Local development

Run `npm run dev` from the repository root and keep that terminal running. It
builds the API packages, starts the API on port 8080 and Vite on port 5173, and
stops the sibling service if either development command exits. This is a local
development process, not a persistent system service or an automatic restart policy.

After renaming or reopening the workspace, stop any old standalone development
commands before starting the root command. Do not start only the web workspace:
its `/api` proxy needs the API process too. A stopped API can produce a session
check error with HTTP 500; a stopped Vite process produces connection-refused or
failed-to-fetch errors. Check `http://localhost:5173/api/health` for HTTP 200, then
reload `http://localhost:5173/leads`. Do not disable authentication to fix a
missing server. Closing the development terminal stops the application.

---

## Local containers

The local stack is isolated from the existing host app: separate named data and
model volumes, no owner-directory mounts, no `.env` secret loading, and only
`127.0.0.1:5180` published. It serves the built React UI and API from one origin.
Login remains required. This is development HTTP, not a server deployment recipe.

```bash
docker compose -f infra/docker-compose.local.yml up -d --build --wait
docker compose -f infra/docker-compose.local.yml exec api node apps/api/dist/setup-owner.js
```

Run the second command directly in your own terminal. It accepts hidden email and
confirmed password input, calls the existing loopback-only setup route from inside
the container, and refuses an existing account. Do not put passwords in shell
arguments, chat, or environment variables. Sign in at `http://localhost:5180`.
This new volume initially has no owner resume or imported leads; the host app's
data is unchanged. Upload a resume and configure the profile in the new app.

### Optional local inference

```bash
docker compose -f infra/docker-compose.local.yml --profile llm up -d --wait
docker compose -f infra/docker-compose.local.yml exec ollama ollama pull qwen2.5:1.5b-instruct-q4_K_M
LOCAL_LLM_ENABLED=true docker compose -f infra/docker-compose.local.yml --profile llm up -d --wait
node scripts/check-container.mjs --llm
```

`LOCAL_LLM_MODEL` overrides the model; download it explicitly before enabling it.
Ollama has no published host port, and no cloud API fallback exists. The transport
accepts only configured local origins, disallows redirects, bounds response size,
and times out after 120 seconds. Local ranking checks at most five full-description
leads serially; failures and over-budget prompts retain deterministic scores with
a run warning. Exclusions and snippet-confidence rules still apply.

The CPU baseline is **not an accuracy recommendation or an interactive-speed
claim**. On an M1 Pro with Docker's approximately 8 GB VM and two inference CPU
cores, a synthetic full ranking request took **96.6 seconds**, with about **1.49
GiB** model-service memory afterward and **113 MiB** API memory. The Qwen3 4B
instruct variant timed out on the same ranking prompt. These are single-request
observations, not representative load or quality benchmarks. Docker Linux does
not use Apple Metal. Faster inference needs different hardware/runtime or a
measured smaller workload; Redis does not speed up model computation.

Tested Ollama image: `ollama/ollama:0.11.10`. Tested baseline model manifest:
`65ec06548149b04c096a120e4a6da9d4017ea809c91734ea5631e89f96ddc57b`
(986,061,892 bytes). Tags remain mutable; verify the manifest before repeating
acceptance or choosing a server image. These versions are not a vulnerability
certification.

To disable inference while preserving models and all app data:

```bash
LOCAL_LLM_ENABLED=false docker compose -f infra/docker-compose.local.yml up -d --wait api
docker compose -f infra/docker-compose.local.yml --profile llm stop ollama
```

### Container acceptance

`node scripts/check-container.mjs` tests `careerscope:local` in a temporary,
network-disabled container with synthetic data. It verifies non-root operation,
read-only root, non-interactive setup refusal, readiness, SPA delivery, auth and
CSRF denial, login rotation, SQLite backup restoration across an API-process
restart, persisted sessions, and logout revocation. Cleanup only removes its own
uniquely named test container. `--llm` additionally sends synthetic facts through
the real running local model and checks unavailable-model fallback. A fallback
is deliberately a failed inference acceptance check, not a false success.

Docker must remain running and the computer must remain awake; `restart:
unless-stopped` is not 24/7 availability on a sleeping laptop. Use `stop` or
`down` without `-v` to preserve named volumes. Do not delete volumes as a reset.
The acceptance backup covers SQLite only; owner resumes, filesystem state,
off-host encrypted backups, full disaster recovery, server TLS and rollback need
separate acceptance before deployment.

This foundation adds local ranking, not an autonomous replacement for Copilot:
Gmail mark-read automation, a local application-preparation agent, and the in-app
assistant remain unimplemented. Application submission and account/terms steps
still require explicit approval. No server or public release is created here.

## EC2 first boot

### The instance

For the API without local inference, `t3.small` (2 GB) is enough — the API idles around 120 MB and peaks near 400 MB
during a search. `t3.micro` (1 GB) works but has no headroom for
`docker compose build`; build elsewhere or add swap. 20 GB of disk is generous:
images and layers dominate, the database does not.

Security group: **22, 80, 443 inbound.** Nothing else. Port 8080 is deliberately
not published — see `expose:` rather than `ports:` in the compose file. If 8080
is reachable from the internet, the API is being hit without TLS.

### Install Docker (Amazon Linux 2023)

```bash
sudo dnf install -y docker git
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
newgrp docker                          # or log out and back in
docker compose version                 # v2 ships with the plugin
```

On Ubuntu, use the official convenience script from docs.docker.com rather than
the distribution's `docker.io` package, which is usually a version or two behind
on the compose plugin.

### Clone and configure

```bash
sudo install -d -o "$USER" -g "$USER" /opt/job-radar
git clone <your-repo-url> /opt/job-radar
cd /opt/job-radar
cp .env.example .env
```

Now edit `.env` and protect it with `chmod 600 .env`:

```bash
# 32 random bytes. Anything shorter than 24 characters is refused at boot.
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

- `AUTH_ORIGIN` — your exact public HTTPS origin, for example `https://jobs.example.com`.
- `LOGIN_ENABLED=true` and `AUTH_DISABLED=false` — create the owner locally and
  restore that database into the production volume before allowing sign-in.
- `APP_API_KEY` — optional independent automation credential. Do not put it in
  the browser when using owner login. Generate one only if automation needs it.
- Provider keys — `ADZUNA_APP_ID` / `ADZUNA_APP_KEY`, `JOOBLE_API_KEY`,
  `RAPIDAPI_KEY`. All optional; unavailable sources are labeled in the UI.
  Availability is not a promise that an external portal will respond to every run.

`.env` is gitignored and never travels through CI. It exists **only** on the
box, which means: if you lose the instance, you lose the file. Keep the key in a
password manager.

`AUTH_DISABLED` and `NODE_ENV` need no attention — compose overrides both, so a
development value left in `.env` cannot follow you into production.

### Start

```bash
docker compose -f infra/docker-compose.yml up -d --build
```

First build takes 3–6 minutes on a `t3.small`. Then:

```bash
docker compose -f infra/docker-compose.yml exec -T api node -e "fetch('http://127.0.0.1:8080/api/health/ready').then(r=>process.exit(r.ok?0:1))"
docker compose -f infra/docker-compose.yml ps  # api healthy, nginx up
```

Point DNS at the instance's elastic IP, then configure TLS. HTTP application
routes return 503 during this bootstrap phase; this is intentional. Keep the
production `AUTH_ORIGIN` in the root `.env` and run Compose from that directory,
or supply it explicitly through the shell/Compose `--env-file` option.

---

## The browser-backed sources (optional)

LinkedIn, Naukri and Indeed have no public API. Reaching them means running a
real Chromium over their public search pages, which is off by default and is a
separate, much larger image. Skip this whole section unless you want them.

### What it costs

- **Disk and RAM.** The image carries Chromium, its shared libraries and an X
  server. A `t3.small` (2 GB) can run it, but not comfortably alongside a large
  search — `t3.medium` if this tier is going to be used regularly.
- **Time.** A browser walk is minutes where an API call is seconds. Runs stream
  progress over SSE precisely so this is visible while it happens.

### Turning it on

```bash
# 1. In /opt/job-radar/.env
ENABLE_SCRAPERS=true

# 2. Build the scrape target instead of the default one.
#    These two variables are read from the shell, not from .env — Compose
#    interpolates the file before it ever reads `env_file`.
cd /opt/job-radar
API_TARGET=api-scrape API_TAG=scrape \
  docker compose -f infra/docker-compose.yml up -d --build
```

Confirm the browser is actually usable in the image before trusting a run:

```bash
docker compose -f infra/docker-compose.yml exec api \
  /usr/local/bin/xvfb-exec.sh node -e "
    import('playwright').then(async ({ chromium }) => {
      const b = await chromium.launch({
        headless: false,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      });
      console.log('chromium', b.version());
      await b.close();
    })"
```

That prints a version or fails loudly. It is worth running after any base-image
change, because everything it exercises — the X server, the browser binary, the
shared libraries — is invisible to the health check.

### Why headed, and why that needs an X server

Chromium runs with `headless: false`. Naukri's edge refuses a headless browser
and serves the same page normally to a headed one, and headless mode is the
literal thing it inspects — so this is not a disguise, it is running the browser
for real. A server has no display, so `infra/xvfb-exec.sh` starts an `Xvfb` and
`exec`s the server into it. The `exec` matters: the API keeps PID 1 and still
receives `SIGTERM` directly, so `docker stop` still drains in flight requests.

`xvfb-run` would have been the one-liner, but it runs the command as a child and
does not forward `SIGTERM` — every deploy would have ended in a `SIGKILL` nine
seconds later.

### What these sources will not do

- **No stealth.** No fingerprint patching, no client-hint forgery, no captcha
  solving, no signed-token reimplementation, no signed-in session. Every page
  fetched is one a logged-out visitor can open.
- **Indeed detail pages are never fetched** — `robots.txt` disallows `/viewjob`.
  Indeed leads therefore carry the search snippet only, stay marked
  low-confidence, and are **capped at 80%**, below the default 85% threshold. If
  Indeed appears to return nothing, this is why; drop the match slider to see
  them.
- **A block is reported, never swallowed.** Rate limits, login walls, captchas
  and Cloudflare interstitials are each named in `GET /api/runs/:id/logs`. A
  walled source never reports "0 postings matched" — that reads as a quiet
  market and sends you looking in the wrong place.

### Going back

Rebuild without the two variables. The small image reports the three sources as
unavailable, naming Playwright as what they want, and every other source carries
on unchanged — `ENABLE_SCRAPERS=true` against the browserless image is a
supported state, not a broken one.

---

## TLS

The stack ships with plain HTTP as the default because **the ACME challenge has
to be answerable before any certificate exists**, and nginx refuses to start
when `ssl_certificate` points at a file that isn't there. So: issue first, then
swap the config.

### Issue

```bash
cd /opt/job-radar
docker compose -f infra/docker-compose.yml --profile certbot run --rm certbot \
  certonly --webroot -w /var/www/certbot \
  -d jobs.example.com \
  --email you@example.com --agree-tos --no-eff-email
```

`jobs.example.com` must already resolve to this box. Let's Encrypt validates by
fetching `http://jobs.example.com/.well-known/acme-challenge/…`, which
`job-radar.conf` already routes to the shared webroot volume.

### Swap the config

Edit `infra/nginx/job-radar-tls.conf` and replace **all four** occurrences of
`jobs.example.com` — two `server_name`, two certificate paths:

```bash
sed -i 's/jobs\.example\.com/YOUR.DOMAIN/g' infra/nginx/job-radar-tls.conf
```

Then select the TLS configuration in the root `.env` used for Compose interpolation:

```dotenv
NGINX_CONFIG=./nginx/job-radar-tls.conf
```

```bash
docker compose -f infra/docker-compose.yml up -d
docker compose -f infra/docker-compose.yml exec -T nginx nginx -t
curl -fsS https://YOUR.DOMAIN/api/health
curl -sI http://YOUR.DOMAIN/ | head -1        # expect 301
```

> Editing a tracked file on the box means the next deploy's `git reset --hard`
> reverts it. Commit the change to your repository — the domain is not a secret.

### Renewal

Certificates last 90 days. Renew from cron:

```bash
sudo crontab -e
```

```cron
17 3 * * 1 cd /opt/job-radar && docker compose -f infra/docker-compose.yml --profile certbot run --rm certbot renew --quiet && docker compose -f infra/docker-compose.yml exec -T nginx nginx -s reload
```

Weekly at 03:17 — certbot no-ops until inside the 30-day window, so a weekly run
gives four chances to succeed before anything expires. The `nginx -s reload` is
required: nginx holds the old certificate open otherwise. `-T` disables the TTY,
without which cron's non-interactive shell fails.

Check it works before you need it:

```bash
docker compose -f infra/docker-compose.yml --profile certbot run --rm certbot renew --dry-run
```

---

## systemd instead of Docker

For a box where you would rather not run a container runtime. Node 24+ required.

```bash
sudo useradd --system --home /opt/job-radar --shell /usr/sbin/nologin jobradar
sudo install -d -o jobradar -g jobradar /opt/job-radar/data

cd /opt/job-radar
npm ci
npm run build
sudo chown -R jobradar:jobradar /opt/job-radar

sudo cp infra/job-radar.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now job-radar
sudo systemctl status job-radar
```

The unit runs `db/migrate.js` on every start (idempotent — it checks the schema
version and returns early) and `db/seed.js` with a leading `-`, so a bad seed
file costs enrichment quality but never stops the API.

nginx here is the host's own. Copy `infra/nginx/job-radar.conf` and
`locations.inc` into `/etc/nginx/`, adjust `proxy_pass` to `127.0.0.1:8080`, and
use the distribution's `certbot --nginx` rather than the containerised one.

Two notes on the hardening block, both of which have cost people an afternoon:

- `ReadWritePaths=/opt/job-radar/data` is the **only** writable path. Point
  `DATA_DIR` anywhere else and the process dies on first write.
- `MemoryDenyWriteExecute` is deliberately absent. V8 maps JIT pages writable and
  then executable; enabling it does not harden Node, it stops it from starting.

Rebuild after a pull: `npm ci && npm run build && sudo systemctl restart job-radar`.

To run the browser-backed sources under systemd rather than Docker, three
additions — the container target does all three for you:

```bash
sudo apt-get install -y --no-install-recommends xvfb   # or dnf, on AL2023
sudo -u jobradar npx playwright install --with-deps chromium
```

then wrap `ExecStart` in the same helper the image uses, so the X server comes
up first and node still ends up as the main process:

```ini
ExecStart=/opt/job-radar/infra/xvfb-exec.sh /usr/bin/node /opt/job-radar/apps/api/dist/index.js
```

The hardening block above is already compatible: `PrivateTmp=true` gives Xvfb
and Chromium a private, writable `/tmp`, and `RestrictNamespaces=true` is
survivable only because Chromium is launched with `--no-sandbox` (see
`LAUNCH_ARGS` in `packages/providers/src/scrape/browser.ts`). Leave
`MemoryDenyWriteExecute` unset — it stops Chromium for the same reason it stops
Node.

---

## GitHub Pages

Only for the split deploy. Three one-time steps, all in the repository settings.

1. **Settings → Pages → Source: GitHub Actions.**
2. **Settings → Secrets and variables → Actions → Variables →** new variable
   `API_BASE_URL`, set to the API's public origin:

   ```
   https://jobs.example.com
   ```

   Origin only. **No trailing slash, and no `/api`** — the client appends both.
   The workflow fails the build if this is unset, because an empty value
   produces a site whose every request resolves back to `github.io` and returns
   HTML where JSON was expected.

3. **On the API box**, set `CORS_ORIGINS` in `.env` to the Pages origin — the
   scheme and host only, no path:

   ```
   CORS_ORIGINS=https://<owner>.github.io
   ```

   Then remove the `CORS_ORIGINS: ""` line from `infra/docker-compose.yml`'s
   `environment:` block, or it will keep overriding the file, and restart.

Push to `main`. The workflow builds with the right `base` path for the repository
name, copies `index.html` to `404.html` so a hard refresh on `/leads` still
works, and publishes.

To verify the wiring rather than guess at it: open the Pages URL, then the
browser's network tab, and confirm requests go to your API host and come back
`200` with JSON. A `404` that returns HTML means `API_BASE_URL` was wrong; a CORS
error in the console means step 3 was missed.

---

## CI/CD

GitHub Pages deploys the validated static artifact after successful CI on `main`.
EC2 is manual-only while its acceptance gates remain unverified; even a manual
run requires repository variable `ENABLE_EC2_DEPLOY=true`. Do not enable it for
the Pages-only release. Container CI checks run when `ENABLE_CONTAINER_CI=true`
or CI is launched manually.

The EC2 workflow also needs four secrets and supports an optional path variable:

|                            |                                                       |
| -------------------------- | ----------------------------------------------------- |
| `EC2_SSH_KEY`              | private half of a deploy keypair                      |
| `EC2_HOST`                 | hostname or elastic IP                                |
| `EC2_USER`                 | login user; must be in the `docker` group             |
| `EC2_KNOWN_HOSTS`          | `ssh-keyscan -H <host>`, run from a machine you trust |
| `EC2_APP_DIR` _(variable)_ | checkout path; defaults to `/opt/job-radar`           |

```bash
# locally
ssh-keygen -t ed25519 -f ~/.ssh/job-radar-deploy -N '' -C 'job-radar deploy'
ssh-copy-id -i ~/.ssh/job-radar-deploy.pub ec2-user@jobs.example.com
ssh-keyscan -H jobs.example.com            # → EC2_KNOWN_HOSTS
cat ~/.ssh/job-radar-deploy                # → EC2_SSH_KEY, whole file including headers
```

`EC2_KNOWN_HOSTS` is mandatory rather than convenient: without it the workflow
would need `StrictHostKeyChecking=no`, and the deploy would be one DNS hijack
away from handing a production key to whoever answers.

The deploy does `git reset --hard origin/main`, rebuilds, prunes dangling images,
and polls `/api/health` for 60 seconds. On failure it prints the last 80 log
lines and exits non-zero. **Anything you edited on the box that is tracked in git
is discarded** — that is the point, and it is why the TLS domain belongs in a
commit.

Manual redeploy — after editing `.env`, for instance, where no commit exists:
**Actions → Deploy API to EC2 → Run workflow.**

---

## Backup and restore

Everything worth keeping is in the `job-radar-data` volume: the SQLite database,
its WAL, and uploaded resumes.

```bash
docker run --rm \
  -v job-radar_job-radar-data:/data:ro \
  -v "$PWD":/backup alpine \
  tar czf /backup/job-radar-$(date +%F).tar.gz -C /data .
```

The volume is `job-radar_job-radar-data` — compose prefixes the project name
(`name: job-radar` at the top of the compose file). `docker volume ls` if unsure.

A hot copy is _usually_ fine because SQLite is in WAL mode, but "usually" is not
a backup policy. For a guaranteed-consistent snapshot, stop the API first:

```bash
docker compose -f infra/docker-compose.yml stop api
# …tar as above…
docker compose -f infra/docker-compose.yml start api
```

A search run takes minutes and the app is single-user; ten seconds of downtime at
3am costs nothing.

### Restore

```bash
docker compose -f infra/docker-compose.yml down
docker volume rm job-radar_job-radar-data
docker volume create job-radar_job-radar-data
docker run --rm \
  -v job-radar_job-radar-data:/data \
  -v "$PWD":/backup alpine \
  tar xzf /backup/job-radar-2026-01-15.tar.gz -C /data
docker compose -f infra/docker-compose.yml up -d
```

Then `curl -fsS https://YOUR.DOMAIN/api/health/ready` and confirm your leads are back in
the UI. A restore you have not tested is a hypothesis.

> **Why a named volume and not a bind mount.** The image sets `/app/data`
> ownership for uid 1000, and a named volume inherits it. A bind mount keeps the
> _host_ directory's ownership instead, so the non-root process cannot write and
> the container restart-loops on `SQLITE_CANTOPEN`. If you switch to a bind
> mount, `chown -R 1000:1000` the host directory first.

---

## Logs

```bash
docker compose -f infra/docker-compose.yml logs -f api
docker compose -f infra/docker-compose.yml logs -f nginx
docker compose -f infra/docker-compose.yml logs --since 30m api
```

JSON lines from pino, capped at 10 MB × 3 files per service. Readable with
`| npx pino-pretty` if you have Node on the box.

Under systemd: `journalctl -u job-radar -f`, `journalctl -u job-radar --since '1 hour ago'`.

**Credentials never appear.** The logger redacts credential paths and request
headers, `describeFailure` deliberately never dumps a URL because some carry API
keys as path segments, and the settings surface reports `set` / `unset` and
nothing more. If you ever see a key in a log line, that is a bug worth reporting.

Application-level history is in the database, not the logs — per-run progress
lives in `run_events` and is what `GET /api/runs/:id/logs` reads.

---

## Routine operations

```bash
# Redeploy by hand
cd /opt/job-radar && git pull && docker compose -f infra/docker-compose.yml up -d --build

# Restart without rebuilding
docker compose -f infra/docker-compose.yml restart api

# Reclaim disk (untagged layers accumulate ~200 MB per deploy)
docker image prune -f
docker system df

# Change a provider key
$EDITOR .env && docker compose -f infra/docker-compose.yml up -d
# `up -d` re-reads env_file; `restart` does not.

# Rotate the API key
$EDITOR .env && docker compose -f infra/docker-compose.yml up -d
# then re-enter it on the settings screen — old browser sessions will 401.

# Inspect the database
docker compose -f infra/docker-compose.yml exec api \
  node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/app/data/job-radar.db');console.table(d.prepare('select status,count(*) n from leads group by status').all())"
```

---

## Troubleshooting

### The container restart-loops immediately

Env parsing failed at boot — by design, so a misconfiguration is loud. The log
names the variable:

```bash
docker compose -f infra/docker-compose.yml logs api | head -30
```

Most common: `APP_API_KEY` missing or under 24 characters, or `AUTH_DISABLED=true`
with `NODE_ENV=production`, which is refused outright.

### `SQLITE_CANTOPEN` or a permission error on `/app/data`

Volume ownership. See the note at the end of [Backup and restore](#backup-and-restore)
— almost always a bind mount substituted for the named volume.

### nginx will not start

```bash
docker compose -f infra/docker-compose.yml logs nginx
```

If it names a missing `ssl_certificate`, the TLS config is mounted but no
certificate has been issued. Switch the mount back to `job-radar.conf`, issue the
certificate, then swap again — in that order.

### Health check passes locally, the site does not load

Work outward: `curl http://127.0.0.1/api/health` on the box (nginx + API), then
`curl http://<elastic-ip>/api/health` from your laptop (security group), then by
hostname (DNS). Whichever step fails first is the layer to fix.

### The app loads but every request 401s

The key in the browser does not match `APP_API_KEY` on the server. Re-enter it on
the settings screen. If it still fails, confirm the container actually picked up
the current `.env` — `restart` does not re-read it, `up -d` does.

### Search finds nothing

1. Settings screen → check which sources report as configured.
2. Lower the threshold. 85% is strict by design, and it is strict on purpose: a
   job whose full JD could not be fetched is capped at 80%, so crossing 85%
   always means the description was actually read. Try 70% to see what is being
   filtered.
3. `GET /api/runs/:id/logs` shows per-source counts and per-source failures. A
   source returning zero is different from a source erroring, and both are
   different from a source that was turned away — a block is named in the log.
4. If LinkedIn, Naukri or Indeed report as unavailable, see
   [The browser-backed sources](#the-browser-backed-sources-optional). Indeed in
   particular returns nothing at the default threshold by design.

### Withdrawn job cleanup

The v1 search runner checks up to 25 existing Greenhouse/Lever leads after each
refresh, rotating a persisted cursor through eligible leads with a 30-second
total budget. It deletes a lead only when the exact, uncached ATS job endpoint
returns JSON with HTTP 404/410 and the same employer's board returns a valid
posting list that does not contain that job. Redirects, access challenges,
timeouts, rate limits, malformed responses and missing search results are not
removal evidence. Greenhouse board-scoped IDs support custom employer URLs only
when the URL includes the matching `gh_jid`. Other sources and unrecognized
employer URLs remain unchecked.

Only untouched `new` leads are eligible. Saved leads, notes, application statuses
and application-run history are preserved, with guards rechecked at deletion to
protect concurrent edits. The job record remains; no application history is
deleted. Run logs report checked, removed and inconclusive counts. This is a
bounded best-effort check, not instant or universal expiry detection. MCP workers
already running before a code update need restarting to load the new runner.
Public snapshots are unchanged until a separately authorized export/publication.

### SSE progress arrives in one lump at the end

`proxy_buffering off` is missing on `/api/runs/*/events`. It is set in
`locations.inc`; check that file is actually mounted and that no other proxy
(CloudFront, an ALB) sits in front re-buffering the stream.

### Disk full

```bash
docker system df
docker image prune -f
docker builder prune -f       # the build cache is usually the culprit
```

---

## Known issues

- `npm audit` reports **two moderate advisories**, both reached through
  `exceljs → uuid`. Accepted rather than fixed: `exceljs` has no release that
  resolves it, the code path only runs when you click export, and the input is
  your own leads. Re-check on `exceljs` upgrades.
- Nothing in `infra/` has been built or run on a developer machine. See the note
  at the top.
