# Windows Verification And Hostinger Staging

Evidence date: 2026-09-17. This is a preparation record, not deployment approval
or a production-readiness certificate. No commits, pushes, server provisioning,
DNS changes, public exposure, job searches or real applications were performed.

## Checklist

- [x] Confirm Windows workspace and verify migration preservation.
- [x] Pin local MCP to Node 26.8.1 and the separate working database.
- [x] Disable MCP scheduling, startup recovery and mutating tools.
- [x] Check read-only MCP profile, lead, detail and source tools over stdio.
- [x] Review V1 ownership, authentication, provider boundaries and deployment templates.
- [x] Review V2 implementation boundaries without activating its services.
- [x] Check provider HTTPS connectivity without downloading job bodies.
- [x] Verify model archive integrity and assess Windows hardware.
- [x] Inspect the existing Hostinger plan and backup/access controls read-only.
- [x] Run V1 project gates and isolated three-browser checks.
- [ ] Obtain approval and authenticated administrative access for private staging.
- [ ] Validate native Linux runtime, restore, monitoring and rollback on staging.
- [ ] Obtain separate approval for DNS, TLS issuance and public exposure.

## Findings And Fixes

1. **Fixed: secondary MCP startup could change API-owned runs.**
   `createContainer` previously always called `reapOrphans`, even when another
   process owned those runs. `recoverOrphans: false` now lets an observer leave
   them untouched; default API recovery is preserved. Disposable two-container
   tests cover both behaviors. This does not make V1 a multi-writer worker system.
2. **Fixed for Windows: MCP exposed mutations alongside a second local queue.**
   The guarded launcher now uses `startScheduler: false`,
   `recoverOrphans: false` and `buildMcpServer(..., { readOnly: true })`.
   All six mutating tools reject before effects: profile updates, resume imports,
   searches, cancellation, lead edits and filesystem exports. Five read tools
   remain usable. Tool discovery still lists all 11 tools; write calls are denied.
   Standard writable MCP behavior remains available outside this opt-in mode.
3. **Fixed: Windows WebKit skipped the keyboard skip link.**
   The problem reproduced without application code. An explicit `tabIndex={0}`
   on the skip link restores keyboard reachability. The Layout regression and
   unchanged three-browser keyboard checks pass. A speculative test-shortcut
   change did not fix the problem and was removed.
4. **Fixed: Windows WebKit mobile lead rows overlapped after desktop resize.**
   Screenshot inspection caught a defect the original DOM gate missed. The new
   bounded overlap assertion reproduced it even after resize settled. A custom
   virtualizer measurement reads the current row bounding-box height instead of
   reusing cached desktop measurements. All three browser checks now pass the
   overlap assertion; WebKit and Chromium mobile screenshots were inspected.
5. **Blocker: Hostinger has zero provider firewall rules and no backups yet.**
   Weekly scheduling is not evidence of a restorable backup. The host firewall,
   patch level, listening services, SSH authorization and recovery path remain
   unverified because no remote shell was opened. Do not expose the app yet.
6. **Blocker: existing deployment examples are not a staging release pipeline.**
   The Compose stack defaults to HTTP proxying, has no V1 service CPU/memory
   limits, and uses moving image tags. The EC2 workflow resets to `origin/main`,
   builds in place and prunes images without an automatic rollback. It is
   manual/feature-gated and must remain disabled. Do not repurpose it for Hostinger.
7. **Residual risk: V1 parses authenticated uploads in the API process.**
   Its upload byte limit is not a bound on PDF/DOCX expansion, CPU or total RSS.
   V2's restricted parser is a separate implementation, not protection for V1.
   Initial staging should use synthetic fixtures and deny uploads/searches;
   wider exposure needs an explicit decision on parser isolation and resource limits.

## Verified Windows State

- Windows 11, workspace on the existing feature branch; V1 remains operational
  on loopback port 8080. Original unrelated infrastructure edits were retained.
- Migration and supplement ZIP checksums match their sidecars. Original business
  tables match all ten migration fingerprints. The working copy matches the nine
  non-settings fingerprints; its scheduling setting is deliberately paused.
- Both databases retain 3,107 leads, all `new`, and eight non-empty notes.
  The profile and linked resume were accessible through the signed-in API.
  Downloaded resume bytes matched the verified backup SHA-256.
- Local MCP uses the executable under
  `data/windows-toolchain/node_modules/node/bin/node.exe`, version 26.8.1.
  Its original `ERR_MODULE_NOT_FOUND` named `@modelcontextprotocol/sdk` before
  dependency installation, under system Node 22.23.2. The full import graph now passes.
- `.vscode/mcp.json` invokes `data/start-windows-mcp.mjs`. The original config is
  retained at `data/session-backups/windows-mcp-before-20260917/mcp.json`.
  Original `.env` and owner database are not used by the MCP process.
- The launcher pins its executable, validates the working database/resume paths,
  refuses active runs, clears inherited application credentials, and disables
  scrapers, inference and application automation. Logs use stderr, not MCP stdout.
- `data/verify-windows-mcp.mjs` checks preflight before connection, calls only
  `get_profile`, `list_leads`, `get_lead`, `list_sources`, then compares all database
  table fingerprints and original configuration hashes. The client closes afterward.
- These launcher/runtime files are intentionally ignored, machine-local setup.
  The Windows-specific MCP configuration is not a portable deployment artifact.
  VS Code tool attachment after restart is distinct from the verified SDK connection.
- No Docker engine/Desktop process was observed. Processes named
  `docker-language-server-windows-amd64.exe` belong to editor language support,
  not the container engine. No Docker command was used.

## Architecture Boundaries

V1 is the supported local baseline: React/Vite -> authenticated Fastify routes ->
repositories and one in-process search queue -> SQLite plus resume files. Shared
Zod contracts and deterministic matching stay in the existing workspace packages.
Provider HTTP, normalization and enrichment stay outside deterministic scoring.
The observer MCP reads the same working data without becoming another writer.

Authentication review covered production HTTPS-origin validation, secure HttpOnly
SameSite cookies, origin checks on session-authenticated writes, constant-time
API-key comparison, rate limiting, local-only owner setup and private response
`no-store` headers. API keys remain full-access credentials. A trusted proxy must
overwrite forwarded headers, and the API must not be independently public.

GitHub Pages remains a separate allowlisted public snapshot/encrypted-admin
artifact. It does not host the API, run searches or execute MCP. No Pages artifact
was exported, staged or published during this work.

V2 remains incomplete `2.0.0-alpha.1`: Next/Fastify, PostgreSQL, transactional outbox,
fenced workers and SQS/LocalStack by default; dedicated persistent Redis/BullMQ is
opt-in. Its documented private storage, parser activation, provider parity,
coordinated recovery and owner-data cutover gates remain open. Current V2 API code
has session/owner, origin and CSRF checks; that is not a complete deployment audit.
Do not migrate V1 data, install V2 services on staging or treat past Mac tests as
Windows/Linux acceptance. V2 dependencies were not installed and integration gates
were not run; its runtime lockfile audit is the only fresh dependency gate.

## Provider Connectivity

One bounded, unauthenticated HEAD request was sent to each representative endpoint;
redirects were not followed, job bodies were not downloaded and no jobs were stored.

| Source          | HTTPS result | Interpretation                                                     |
| --------------- | ------------ | ------------------------------------------------------------------ |
| Greenhouse      | 200          | Transport and representative endpoint reachable                    |
| Lever           | 200          | Transport and representative endpoint reachable                    |
| Ashby           | 200          | Transport and representative endpoint reachable                    |
| SmartRecruiters | 200          | Transport and representative endpoint reachable                    |
| Recruitee       | 200          | Transport and representative endpoint reachable                    |
| Remotive        | 200          | Transport reachable; retain its low collection request budget      |
| Remote OK       | 200          | Transport and endpoint reachable                                   |
| Himalayas       | 200          | Transport and endpoint reachable                                   |
| Workable        | 404          | HTTPS reachable; HEAD did not validate the POST-based jobs adapter |

These are Windows connectivity checks, not complete provider-contract tests or
Hostinger-IP acceptance. No Workable collection POST was sent. JSearch, Adzuna,
Jooble and Gmail remain disabled because credentials are not loaded. Browser-backed
LinkedIn/Naukri/Indeed and application automation remain disabled. Signed-in browser
tabs do not establish provider or MCP authentication readiness.

## Ollama Assessment

The downloaded `qwen3.5:4b` archive is 3,389,992,448 bytes, SHA-256
`cb9324566a7b3467e8fdd33ef92251f2a53a734e8c06d25f6832f1e38100d5ff`, matching the migration
manifest and prior source checksum. It was not extracted or installed.

Observed laptop hardware: about 16 GB RAM, i5-8250U (four cores/eight threads),
Radeon 530 (reported 2 GB VRAM), Intel UHD 620, and about 241 GB free disk before
test-browser installation. Windows meets Ollama's documented OS prerequisite.
The Radeon 530 is not listed for Windows ROCm acceleration. Current Ollama also
documents Vulkan support, but these drivers/devices were not benchmarked and the
reported VRAM is not sufficient evidence of full model offload.

Recommendation: only an approved, single-request CPU-first benchmark with a small
context and no CareerScope profile/resume input. Reserve roughly 6-8 GB of free
RAM for the model plus context/runtime overhead, retain OS headroom, and allow at
least 4 GB for Ollama plus the model copy. These are planning allowances, not
measured consumption. Latency, model compatibility and answer quality are unverified.
Keep inference off the two-vCPU staging VPS. Ollama installation and activation
each require approval; no service or model was activated.

References: [Windows requirements](https://docs.ollama.com/windows),
[GPU support](https://docs.ollama.com/gpu).

## Actual Hostinger Assessment

The signed-in panel reported a running KVM 2 VPS with Ubuntu 24.04 LTS,
two vCPU, 8 GB RAM, 100 GB storage and 8 TB bandwidth. It exposed SSH-key,
firewall and snapshot/backup management. Weekly backups are selected, but the
backup page explicitly reported that no backups exist yet. Daily backups are an
upgrade offer, not a purchased or activated capability in this review.

This is a VPS, not static/shared hosting, and is a plausible capacity envelope for
one V1 API/UI instance without inference or browser automation. It is not evidence
of measured capacity, OS health or a working deployment. SSH client availability
was confirmed locally, but no dedicated CareerScope SSH identity or authenticated
remote shell was verified. An unrelated local key was not tried. No password,
key, account setting, backup or server state was changed through the panel.

## Proposed Staging Plan

Use native systemd plus Nginx on the existing VPS; keep Docker stopped and leave
the Windows V1 instance operational. Do not run the existing EC2 deployment workflow.

### Access And Initial Isolation

1. Obtain approval for a dedicated staging identity, authorized SSH key and host
   changes. Verify the SSH host fingerprint through a trusted independent channel.
   Enter any secrets directly in the terminal or provider UI, never in chat.
2. Inventory the remote OS, patches, services, listening ports, free space and host
   firewall read-only. Identify existing workloads before installing anything.
3. After explicit approval, allow SSH only from the owner's confirmed administrative
   address, with a tested recovery path. Align provider and host firewalls. Do not
   disable existing access until a second authorized connection is tested.
4. Install the reviewed Node runtime and OS dependencies only after host-change
   approval. Use an unprivileged `careerscope-staging` service account, restrictive
   file permissions and no interactive application shell.
5. Start with synthetic data only and loopback-only listeners. No owner migration,
   provider credentials, uploads, search execution or real application work.

### Release, Data And Secrets

- Produce an allowlisted, checksum-identified V1 source artifact from the reviewed
  tree, recording base revision and reviewed patch digest. No commit/push is assumed.
  Exclude `.git`, `.env`, `data`, backups, resumes, browser state, Windows launchers,
  `node_modules`, Repomix output, V2 services and generated private artifacts.
- Install Linux dependencies with the lockfile and build on a controlled target;
  never transfer Windows `node_modules`. Keep immutable release directories and
  a separately owned persistent data directory. Resolve stored resume paths against
  a stable working directory, not a versioned release path.
- Use one V1 API writer. Do not run writable MCP, multiple API replicas or another
  scheduler over the same SQLite file. Disable scheduler construction for staging
  and verify stored scheduling remains paused; an environment interval alone is
  insufficient because saved settings take precedence.
- Use a dedicated staging launcher/unit with pinned runtime, explicit data paths,
  authentication enabled, automation disabled and an allowlisted environment.
  Do not copy the Windows `.env` or blindly reuse `ExecStartPre` migration/seed steps
  from the existing systemd example. Apply reviewed migrations explicitly to the
  synthetic staging database, not to owner data during service startup.
- Provision an independent staging owner privately before public access. Production
  owner setup is deliberately disabled by the API. Store configuration outside the
  artifact with restrictive permissions; never inject provider secrets into the UI.

### TLS And Public Exposure Gate

- Private initial access may use SSH forwarding to loopback. Do not expose the
  production login over plain HTTP. No public DNS or certificate issuance is implied
  by approval for private staging.
- Before public HTTPS: obtain the exact owner-controlled staging hostname, DNS
  approval, administrative allowlist and certificate/ACME terms approval. Select
  HTTP-01 or DNS-01 based on the approved access policy; do not open port 80 blindly.
- Validate certificate hostname/chain, TLS 1.2/1.3, renewal and reload before enabling
  access. Port 80, if approved, serves only ACME and HTTPS redirects, not the app.
  Restrict 443 to approved testers initially; keep 8080, databases and model ports private.
- Set exact HTTPS `AUTH_ORIGIN`, no wildcard CORS, secure cookies and trusted-proxy
  behavior. Nginx overwrites forwarded headers. Confirm unauthenticated 401 responses,
  wrong-origin denials, logout/revocation, upload denial and non-buffered SSE on
  synthetic workflows before exposing owner information.

### Persistence, Recovery And Rollback

- Keep SQLite, resumes and required profile/import files in persistent storage,
  outside releases, with explicit ownership and restrictive permissions.
- Create application-consistent backups using SQLite's online backup API, or stop
  the synthetic writer before a coordinated database/files snapshot. Do not copy
  a live database file alone while its WAL may contain committed changes.
- Record schema version, artifact/runtime versions, row counts, status/note hashes,
  resume hashes and integrity/foreign-key results. Encrypt backups with recovery
  material held separately. Use an owner-approved off-host destination; provider
  snapshots alone do not provide independent recovery.
- Proposed starting retention: seven daily and four weekly application backups,
  subject to storage approval. Initial target RPO: 24 hours; target RTO: 60 minutes.
  These are acceptance objectives, not guarantees. Rehearse restore into a new
  directory and verify authentication, file access and all fingerprints before
  accepting them. Never overwrite either Windows database during rehearsal.
- Keep the previous release and its matching pre-migration backup. Rollback stops
  only staging, selects the previous immutable release and restores its compatible
  database/files into a new directory if required. Verify health/auth/data before
  reopening access. Do not roll back schema by guessing or reset/prune live releases.

### Monitoring And Resource Budget

- Initial API budget: `MemoryHigh=1G`, `MemoryMax=1536M`, `CPUQuota=100%`,
  `TasksMax=128`, bounded restart attempts and a 20-second shutdown allowance.
  Reserve the remaining CPU/RAM for OS, proxy and backups; no Ollama or browser worker.
  These conservative limits require adjustment from measured staging behavior.
- Use systemd hardening compatible with Node's JIT: unprivileged user,
  `NoNewPrivileges`, private temp space, read-only system paths and only the data
  directory writable. Validate each setting on Linux; do not assert container acceptance.
- Bound proxy request/body/time limits and login rate; deny unneeded mutation/upload
  routes during initial read-only staging. Limit logs and avoid request bodies,
  cookies, tokens, profile text, notes and personalized URLs in logs.
- Monitor process restarts/OOM, readiness, CPU/RSS, free disk/inodes, WAL growth,
  event growth, TLS expiry, backup age and restore results. Proposed alerts: disk
  above 80%, missing daily backup beyond 26 hours, certificate expiry within 21 days,
  repeated readiness failures or any unexpected search run. Notification destination
  requires owner approval; do not activate a paid monitoring service.

## Validation Evidence And Remaining Gates

| Check                              | Result                                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------- |
| V1 typecheck, lint, build, format  | Passed after final code changes                                                                          |
| V1 tests                           | 1,047 passed, 67 files, none skipped                                                                     |
| Scheduler/MCP focused tests        | 14 passed, synthetic fixtures                                                                            |
| Layout focused tests               | 10 passed                                                                                                |
| MCP stdio reads                    | Passed; both database fingerprints and original config unchanged                                         |
| Chromium/Firefox/WebKit UI         | Passed at 320, 390, 768, 1024 and 1440 widths; no page errors/overflow; keyboard and theme checks passed |
| Dependency audit                   | Zero known runtime advisories in V1 and V2 lockfile; not a security certification                        |
| Shell syntax                       | All three wrappers passed individual Git Bash syntax checks                                              |
| POSIX runtime guard suite          | Failed to launch `sh` on Windows (`ENOENT`); behavior remains unverified on Linux                        |
| V2 runtime/integration/restore     | Not run; dependencies/services absent, Docker deliberately not started                                   |
| Hostinger runtime/TLS/restore/load | Not run; deployment/access approval required                                                             |
| Ollama inference                   | Not run; installation/activation approval required                                                       |

The review was targeted at owning paths and deployment risks, not a line-by-line
audit of every module. Public staging remains blocked on Linux/runtime acceptance,
authorized access, firewall/TLS policy and a successful independent restore rehearsal.

## Exact Approvals Needed

**Next recommended approval:** permit private V1 staging on the existing VPS using
native Node/systemd, synthetic data and loopback-only access, including a dedicated
SSH identity, required OS packages/service account, reviewed host hardening and
firewall changes that preserve existing access. Confirm the authorized SSH access
method and administrative source address outside secret-bearing chat. Docker,
searches, schedules, provider credentials, automation and owner-data transfer stay off.

**Separate public-stage approval:** provide the staging hostname and approved tester
allowlist, authorize the required DNS/ACME actions and public 80/443 policy, and
select an approved encrypted off-host backup/alert destination. No paid upgrade is
assumed. Do not expose staging until the acceptance checks above pass.

**Separate optional Ollama approval:** install a local runtime and run one bounded
CPU-first benchmark using the verified 4B archive and synthetic input, with no
startup registration, LAN exposure or CareerScope integration.
