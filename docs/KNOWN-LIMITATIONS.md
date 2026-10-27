# Known limitations

- Service-backed integration and browser checks require local PostgreSQL,
  Redis, queue and browser dependencies.
- Paid job providers and email integrations remain configuration and
  account-approval gated; unavailable providers fail closed.
- Application submission is always external and user-controlled. CareerScope
  records only explicit user actions or verified permitted provider events.
- Off-host backup, live firewall verification, screen-reader review and
  production smoke testing require the target environment and human evidence.
- Matching and preparation are deterministic. External AI execution is currently removed.
- The admin test identity is isolated from candidate data; it does not enable
  a privileged admin control plane. Hosted test mode is not a public authentication system.
