# EC2 Application Runtime

## Verification Status

This is an opt-in, single-host deployment of the frontend, API, SQLite data,
Copilot CLI and a visible Chromium application browser. Docker was unavailable
on the development Mac when this configuration was added. Shell startup guards
and application tests can run locally; image builds, remote browser access,
Copilot authentication in the image and EC2 operation remain acceptance gates,
not verified claims. Do not promote this configuration without completing them.

Use a supported Docker Engine with Compose v2 on Linux. Start with an x86-64
EC2 instance with at least 2 vCPUs, 4 GB RAM and 30 GB encrypted storage; 8 GB RAM
gives more headroom for builds and concurrent browser searches. These are starting
sizes, not measured capacity guarantees. ARM/Graviton requires a separate build
and browser/CLI smoke test. Use one API replica and one persistent SQLite volume.

## Local Versus Server Sessions

The Shared browser handoff operates through the tabs shared with VS Code on
your Mac. A remote server cannot reuse those tabs or your VS Code subscription
session automatically. For server-hosted automation, choose **Local agent** in
the application panel: here "local" means local to the API host, namely EC2.

The agent uses Copilot CLI authenticated on that host and a separate persistent
Chromium profile. Sign in to job portals there when required. Never copy cookies
from your Mac or bake credentials into an image. A Copilot entitlement and provider
availability are external prerequisites; a successful Docker health check does
not establish Copilot authentication or successful applications.

Account creation, terms and final submission remain separate approvals. Keep
automatic submission unchecked for the first test. CAPTCHA and passwords are
entered directly into the remote browser. The optional Gmail OTP reader requires
the credentials in [Gmail setup](GMAIL.md); your shared Mac Gmail tab is not that
reader. Verification can also be completed manually.

## Build And Bootstrap

Follow [the runbook](RUNBOOK.md) for Docker installation, a production HTTPS
origin, owner-account data restore and TLS certificate issuance. Use the existing
root `.env` locally; on a new host create a protected `.env` using the documented
example. Do not replace your local credentials with deployment examples.

Run these commands from the repository root, using the same Compose options for
every operation:

```sh
docker compose --env-file .env -f infra/docker-compose.yml -f infra/docker-compose.apply.yml config --quiet
docker compose --env-file .env -f infra/docker-compose.yml -f infra/docker-compose.apply.yml build api
docker compose --env-file .env -f infra/docker-compose.yml -f infra/docker-compose.apply.yml run --rm --no-deps --entrypoint x11vnc api -storepasswd
docker compose --env-file .env -f infra/docker-compose.yml -f infra/docker-compose.apply.yml run --rm --no-deps --entrypoint copilot api login
docker compose --env-file .env -f infra/docker-compose.yml -f infra/docker-compose.apply.yml up -d
```

Enter the VNC password directly in the terminal and accept its default destination
`/home/node/.vnc/passwd`. Complete Copilot's interactive sign-in directly; never
paste credentials or device codes into chat. The persistent agent-home volume is
mounted for both setup commands and the running service. The image pins CLI
1.0.83 and uses the lockfile's Playwright Chromium. Upgrade them only with another
runtime smoke test. Scrapers remain controlled separately by `ENABLE_SCRAPERS`.

The default nginx config is an ACME bootstrap that intentionally returns 503 for
application routes. Set `NGINX_CONFIG` to the configured TLS file after issuing
the certificate, as described in the runbook. `AUTH_ORIGIN` must exactly match
the public HTTPS origin. Do not disable production authentication to make a smoke
test pass. A fresh data volume does not contain your local owner, profile or resume;
restore a consistent backup before exposing owner login.

## Remote Browser

Port 6080 is published on host **127.0.0.1 only**. Do not add EC2 security-group
rules for 6080, 5900 or 8080. Restrict SSH to your address or use an equivalent
authenticated SSM tunnel. From the Mac:

```sh
ssh -N -L 6080:127.0.0.1:6080 ec2-user@YOUR_EC2_HOST
```

Open `http://localhost:6080/vnc.html`, connect, and enter the VNC password directly
there. The viewer carries sensitive browser content. VNC password authentication
alone is not a substitute for the encrypted SSH tunnel. For Docker on this Mac,
the same loopback URL works without SSH. Never expose this viewer through public
nginx. Only trusted containers should share this Docker network.

Start an application from the authenticated app, then use the viewer for browser
sign-in or challenges. Approve the agent's questions in **Applications**, not by
clicking a separate Submit control in the viewer. Avoid duplicate submissions.

## Persistence And Recovery

- `job-radar-data`: database, uploaded resumes and the application browser profile.
- `job-radar-agent-home`: Copilot authentication and the browser-viewer password.
- Certificate volumes: HTTPS certificates and ACME state.

Back up these private volumes securely along with the protected environment file.
Use the existing SQLite backup/restore procedure; do not copy a live database
without its WAL. Do not use `docker compose down -v` for routine upgrades. Test a
restore into an isolated instance, with scheduling disabled and no active application.
An interrupted submission must be checked on the portal before retrying.

## Acceptance Gates

1. Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` and
   `node --test infra/application-runtime.test.mjs` on the intended revision.
2. Build the image, start with a test/restored volume, and confirm `docker compose
ps` reports the API healthy. Inspect logs without publishing secrets. Verify
   the viewer connects through loopback/SSH, accepts its password, and renders
   Chromium when an application begins. The health check only verifies HTTP
   readiness of the API and viewer, not the entire VNC/CLI connection.
3. Verify HTTPS login, unauthenticated API rejection, profile/resume retrieval,
   lead details, search progress, application history and browser refresh. Confirm
   no private API or viewer is reachable on public ports.
4. In an application's **Local agent** mode, refresh agent status and require
   Copilot available. Run one explicitly approved, suitable real job through
   review, submission and an actual portal confirmation. A clicked button, queued
   run or passed unit test is not an application confirmation.
5. Restart the stack and verify owner login, resume, leads, application history
   and Copilot sign-in persist. Confirm uncertain interrupted runs cannot silently
   resubmit. Exercise cancellation and manual challenge handling before routine use.

No configuration guarantees that every external job portal will accept automation.
The previous shared-browser Indeed test did not open a form even after a manual
click; no application confirmation was obtained. This image does not claim to fix
that external behavior. Keep a failed or blocked attempt distinct from Applied.
