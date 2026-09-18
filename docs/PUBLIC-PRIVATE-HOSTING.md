# Public Jobs And Private Workspace

The React app supports both views on one origin:

- `/` redirects to `/jobs`, the public job list in the existing app design.
- `/login` opens owner sign-in.
- `/leads`, `/profile`, `/search`, `/settings`, and `/applications` retain the
  existing login gate and authenticated API access.
- The private navigation links back to Public jobs. Public navigation links to
  Owner login; signed-in owners are redirected to their leads.

The public route loads only the sanitized `mobile-site/jobs.json` export. It
does not call private APIs or include scores, notes, resumes, profile data, or
application history. Its filters and sorting run in the browser. The build
copies the snapshot to a fingerprinted public asset; export and rebuild to
publish changes. This is not live database synchronization.

## Deployment

GitHub Pages still serves the separate static jobs site. It cannot run the
API, owner sessions, or SQLite. Publishing the combined app requires a server
with persistent storage and HTTPS, using the existing deployment setup in
`infra/` and `docs/RUNBOOK.md`.

Use a single HTTPS origin for both the React app and `/api`. Production must
have `LOGIN_ENABLED=true`, `AUTH_DISABLED=false`, `SERVE_WEB=true`, and
`AUTH_ORIGIN` set to that HTTPS origin. Create the owner account locally on the
server before exposure; never allow public visitors to claim initial setup.
Keep private data, environment secrets, and database backups out of Git and
public web roots. Moving the existing Mac data to a server requires a private,
explicit migration, not a public repository push.

By default, Copilot application filling stays on the Mac and the hosted server
has `ENABLE_APPLICATION_AGENT=false`. The cloud workspace does not remotely
control or synchronize the Mac worker. There is no server-side application
runtime; the remote-browser option was removed along with the EC2 target.

No combined-site deployment or private data migration has been performed.
