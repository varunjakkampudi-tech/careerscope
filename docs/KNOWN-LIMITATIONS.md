# Known Limitations

Everything below is real, current and deliberately recorded. Nothing here is
closed by wishful wording. Status uses only the vocabulary in
[PROJECT-STATE](PROJECT-STATE.md).

---

## Restarting the proxy alone is an outage

**Status: DEFERRED — INTENTIONAL** (mitigated, not eliminated)

Every service uses `network_mode: service:proxy`. That is what keeps Postgres,
Redis, LocalStack and the API bound to loopback with no routable address.

The cost: restarting the proxy container gives it a **new** network namespace,
and Docker leaves every other container attached to the old, dead one. They
continue to pass their own healthchecks while the proxy answers every request
with 502. Docker neither detects nor repairs this.

Discovered by restarting the proxy to prove certificates survive a restart. They
did; the site went down.

**Mitigation:** [restart-stack.sh](../infra/v3/restart-stack.sh) is the only
supported way to restart the proxy. It reattaches dependents in order and
verifies both upstreams from inside the proxy namespace.

**Residual risk:** if Caddy crashes, `restart: unless-stopped` restarts it
automatically and produces the same outage **unattended**. Nothing currently
detects that.

**Proper fix, not yet done:** move namespace ownership to a dedicated do-nothing
container that the proxy also joins, so no internet-facing process owns the
namespace. This is the Kubernetes pause-container pattern. It requires an infra
change, a rebuild and full revalidation.

---

## Hostinger managed firewall is not configured

**Status: OPEN — HUMAN VALIDATION**

The intended policy is allow 22/80/443, deny everything else. It is configured
in hPanel, outside the host, and has not been set up.

The OS nftables ruleset and the loopback-only network namespace are currently
the only inbound layers. Both are verified. But this is a missing layer of
defence in depth, not a theoretical one.

---

## No transactional email

**Status: OPEN — EXTERNAL**

There is no approved sender or provider. Consequently these do **not exist**:

- email verification
- forgot password
- password reset

What does exist is an authenticated change-password endpoint, which requires
the current password.

**Consequence:** if the owner forgets the password, the only recovery is
`setup-owner` run on the host. There is no self-service path.

This cannot be closed from inside the repository. It needs a real provider and a
verified sending domain.

---

## No off-host backup

**Status: SKIPPED — OWNER DECISION**

The owner declined off-host backup on cost. The Docker volumes on the single VPS
are the only copy of the database and of stored resumes.

A `pg_dump` taken before a risky migration protects against a bad migration. It
does not protect against losing the machine. **Local snapshots are not disaster
recovery and must not be described as such.**

Do not reopen this automatically.

---

## Screen reader not validated

**Status: OPEN — HUMAN VALIDATION**

Automated coverage passes: axe with no WCAG 2.0/2.1 A+AA violations,
accessibility-tree assertions, keyboard-only traversal, and reflow at 320 / 390 /
1440 px across Chromium, Firefox and WebKit.

None of that is a screen reader. An accessibility tree describes what _should_ be
announced; it does not prove what NVDA, JAWS or VoiceOver actually announces.
Until a human runs that smoke test, this stays open.

---

## Frontend is a single page

**Status: NOT IMPLEMENTED** (next phase)

`v2/apps/web/src/app` contains exactly one route: `/`. Everything — profile,
resume, leads, preparation, account security — is a component on that one page.

There is no `/login`, no `/leads`, no deep linking, no per-area routing, and no
admin console. See [FRONTEND-ADMIN-ROADMAP](FRONTEND-ADMIN-ROADMAP.md) for what
the API can and cannot support.

---

## The data model does not support several planned pages

**Status: NOT IMPLEMENTED**

`CollectedJob` carries 11 fields. It has **no** salary, tech stack, employment
type, remote flag or required-years data. There is no company entity, no global
job corpus, no saved-search entity, and no admin role or audit table.

Pages that depend on those — market and skills aggregates, company profiles,
public job browsing, alerts, and every `/admin/*` view — cannot be built from
the current schema without new tables and new collection logic. Building the UI
first would mean inventing data, which is forbidden.

---

## Cross-process storage reservation

**Status: DEFERRED — INTENTIONAL**

Resume storage capacity reservation is correct for a **single writer**. The
`statfs`-based reservation is process-local. Two independent writer processes
could each believe they have capacity.

The deployed architecture runs one files worker, so this is not currently
reachable. It becomes real the moment that worker is scaled out.

---

## Scanner discrepancy, unresolved

**Status: OPEN — EXTERNAL**

Trivy reports `ip-address 10.2.0` and `brace-expansion 5.0.7` in the runtime
image. The files actually present are `10.7.0` and `1.1.18+`, confirmed three
ways: `package.json`, `.package-lock.json`, and grepping the installed files.

The reported vulnerable versions are **not in the image**. The cause of the
discrepancy is not understood. It is recorded rather than "fixed", because
inventing a fix for a finding that does not correspond to a real file would be
worse than leaving it visible.

---

## Runtime image is not byte-reproducible

**Status: DEFERRED — INTENTIONAL**

The runtime image runs `apt-get upgrade` at build time. Without it, the
digest-pinned base image never receives Debian security fixes — and it was
shipping known CVEs in `libpcre2-8-0`.

The trade-off: **the same source commit does not produce identical Debian
package bytes** across two builds. The OCI revision label identifies the source,
not the full dependency closure. Do not claim reproducibility.

---

## One intermittent test failure is unexplained

**Status: OPEN — HUMAN VALIDATION**

A reproduced intermittent failure implicated two test files. One was diagnosed:
tests performing 14 and 8 password-hashing operations were running against a 5 s
default timeout, and now carry explicit 30 s timeouts.

The second file was never identified. It has not recurred, but "has not
recurred" is not "fixed". Do not treat this as closed.

---

## AI and auto-apply

**Status: DEFERRED — INTENTIONAL**

AI inference is off. Matching is fully deterministic and makes no external model
calls. Auto-apply is on hold. Naukri is deferred to a later release and, if ever
built, must use legitimate access only — never cookie or session scraping.

These are product decisions, not missing work.
