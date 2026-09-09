# Login And Deployment

## First Use

Open `http://localhost:5173/login` on the machine running the API and create the
owner account. Choose your own email and a unique password of at least 12
characters. No default password is generated, and no real account is created by
the test suite. The email is a login identifier, not an email-verified identity.

This protects the existing single-owner dataset. It is not public registration,
and different accounts do not get separate profiles or leads. Setup closes once
the owner exists. It rejects remote clients, forwarded setup requests and
production mode. Prepare the owner account locally before deployment.

The header profile icon opens the existing profile editor. The sign-out icon
revokes the current session and clears the browser query cache. Other sessions
remain active until they expire or are separately signed out.

## Security Controls

- Passwords use random salts and scrypt (`N=131072`, `r=8`, `p=1`); plaintext
  passwords are not stored. Passwords are limited to 256 characters.
- JWTs use HS256 with a random 256-bit installation key, fixed issuer/audience,
  owner subject, session ID, issue time and one-hour expiration. Verification
  explicitly restricts the algorithm and also checks the server-side session row.
- Session cookies are HttpOnly, host-only, Path=/ and SameSite=Strict. Production
  adds Secure and the `__Host-` prefix. Tokens are not returned in JSON or stored
  in localStorage/sessionStorage. The JWT payload contains no resume/profile data.
- Logout deletes the server session, so replaying that cookie is rejected.
  There is no long-lived refresh token; sign in again after the one-hour expiry.
- Cookie-authenticated writes and login/setup/logout require an explicitly
  allowed Origin. Cross-site Fetch Metadata is rejected. CORS uses explicit
  origins for credentialed requests, never a wildcard.
- Login/setup are limited to five requests per minute per observed client IP.
  Forwarded headers are untrusted by default. Use an edge limiter as well for a
  public deployment; the in-process limiter resets when the API restarts.
- Auth responses and protected API responses use Cache-Control: no-store.
  Session validity is rechecked before live events and on stream heartbeats.
- Credentials and Set-Cookie headers are redacted from structured logs.

## Configuration

`LOGIN_ENABLED=true` is the default and takes precedence over `AUTH_DISABLED`.
The legacy bypass only works in development with `LOGIN_ENABLED=false` and
`AUTH_DISABLED=true`. Do not use that combination on an exposed instance.

Set `AUTH_ORIGIN` to the exact frontend origin, including the development port.
The default is `http://localhost:5173`. Accessing the same app through
`http://127.0.0.1:5173` is a different origin and requires changing configuration.
An additional explicitly trusted same-site origin can be in `CORS_ORIGINS`.
Unrelated cross-site frontend/API deployments are deliberately unsupported by
SameSite=Strict; use a same-origin reverse proxy instead.

For production:

1. Create the owner account locally and deploy its protected SQLite database.
2. Set `NODE_ENV=production`, `AUTH_DISABLED=false`, `LOGIN_ENABLED=true` and an
   HTTPS `AUTH_ORIGIN`. HTTPS is mandatory; terminate TLS at a trusted proxy.
3. Bind the API to loopback/private networking. Never expose a development server.
4. Set `TRUST_PROXY=true` only when all requests pass through a trusted proxy that
   replaces incoming forwarded headers and the API cannot be reached directly.
5. Protect the database, WAL files and backups with filesystem access controls.
   The database contains password hashes, signing key and active session records.

`APP_API_KEY` remains an optional independent credential for trusted automation
when login is enabled. Such a key grants full owner access without browser login;
protect and rotate it separately. It is required if production login is disabled.

## Recovery And Scope

There is no email reset, MFA or public account-recovery endpoint in this change.
Keep the owner password in a password manager. On the local machine, run
`npm run auth:reset -- --confirm-reset` from the repository root with the same
environment and DATA_DIR as the API. The command requires development mode,
enabled login, loopback HOST and AUTH_ORIGIN, and TRUST_PROXY=false. Do not expose
the app to a network during recovery.

Recovery first creates a SQLite backup in a private `owner-recovery-*` directory
beside the database, then clears only `auth_owner` and `auth_sessions`. Profile,
resumes, leads and application history are preserved. Open the local login page
immediately and create the replacement owner account with your new password.
Until then, protected data remains inaccessible and local first-time setup is
open. Passwords never need to be passed through command arguments or chat.

The backup contains sensitive data and old credentials; protect it and remove it
when no longer needed. Clearing sessions does not revoke an independently
configured API key. Recovery refuses production configuration; restore access
on an isolated local copy with filesystem administrator access instead.

Production TLS/proxy configuration must be verified in the deployment environment;
local browser tests do not establish that a public deployment is secure.
