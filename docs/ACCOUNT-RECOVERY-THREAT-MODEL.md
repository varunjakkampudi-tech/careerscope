# Account recovery and verification — requirements and threat model (CS-44)

**Status: REQUIREMENTS AND THREAT MODEL ONLY.** No route, no token, no page, no
email. Nothing here is implemented, and **nothing here may be implemented until
the owner approves a sender, a domain, a secret-handling plan and this security
design** (AC3).

**Registration stays disabled. Existing recovery stays as it is.**

This document also records a **hard blocker discovered while writing it**: one
of AC2's required controls has no viable implementation on this deployment
today. See [The bounded-attempts requirement cannot be met yet](#the-bounded-attempts-requirement-cannot-be-met-yet).

---

## What already exists, and why recovery is separate from all of it

AC1 requires this be documented separately from the surfaces that already work.
They are genuinely different problems:

| Surface                      | State                                                    | Why it is not recovery                                                                                                                               |
| ---------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/account/password` | Implemented. Rate-limited `password:${ownerId}`, 5/hour. | **Authenticated.** The owner proves identity with a live session and the current password. Recovery exists precisely for the case where they cannot. |
| Operator recovery            | Manual, host-access only.                                | Requires a human with server access. Correct as a last resort, unusable as a self-service path, and not something to automate casually.              |
| `POST /api/register`         | **Disabled** — returns `404 Registration unavailable`.   | Creating an account is not recovering one. Note the existing 404: registration already refuses to confirm it exists.                                 |

**The asymmetry that defines the threat model:** authenticated password change
is guarded by a secret only the owner knows. Recovery, by construction, is
guarded by _access to a mailbox_. It is therefore a **second, weaker
authentication path onto the same account**, and its security ceiling is the
security of the email account — which CareerScope does not control.

That is the reason the approval gate in AC3 is substantive rather than
procedural. Enabling recovery permanently changes what an attacker needs in
order to take over an account, from "the password" to "the password **or** the
mailbox".

---

## The bounded-attempts requirement cannot be met yet

AC2 requires **bounded attempts**. Recovery is unauthenticated, so there is no
`ownerId` to key a limiter on. The two keys available are the client IP and the
submitted email address. Both are currently unusable, for different reasons.

### IP keying is inert on this deployment

The existing unauthenticated limiters hash `request.ip`:

```ts
const key = createHash('sha256').update(request.ip).digest('hex');
if (!(await rateLimit(`login:${key}`, 10, 60))) throw new HttpError(429, ...);
```

Per CS-59, verified at source: Caddy proxies to the API over loopback inside a
shared network namespace and its `header_up -X-Forwarded-For` **deletes** the
forwarded header, so `request.ip` is `127.0.0.1` for **every production
request**. Every client hashes to the same key.

These limiters are therefore not per-client at all — they are **one global
bucket shared by the entire internet**. A recovery endpoint keyed the same way
would inherit that, and AC2's "bounded attempts" would be satisfied on paper by
a control that bounds nothing per attacker while letting any single client
exhaust the budget for everyone.

**CS-44 has a hard dependency on CS-59, recorded in `.ai/backlog.json`.**
Recovery must not ship before client identity is recoverable at the application
layer.

**CS-59 is not a sequencing note — it is a proxy-layer change on a single-host
deployment**, the same class as the host-blocked tickets that need an operator
session. Reading "blocked on CS-59" as "wait for the other ticket" understates
it: nothing in the web or API tier can fix this, because the header is deleted
before the application ever sees the request.

### Email keying turns a limiter into an enumeration oracle

The obvious alternative — key on the submitted address — collides head-on with
AC2's **non-enumerating responses** requirement, and the collision is easy to
miss because each control is correct in isolation.

If the limiter rejects with `429` while a normal submission returns `202`, then
the response distinguishes an address that has been submitted repeatedly from
one that has not. An attacker who can provoke different responses for different
addresses has an enumeration oracle — **built out of the control that was
supposed to prevent abuse**. It also lets an attacker deny a known victim
recovery by exhausting their bucket on purpose.

**Resolution, and this is the load-bearing rule of the document:**

> The limiter must gate the **side effect**, never the **response**. A
> rate-limited recovery request returns the same `202` and the same body as an
> accepted one. It simply does not send anything.

A recovery endpoint that can return `429` has already failed AC2, no matter how
well its limits are tuned.

---

## Non-enumerating responses (AC2)

Every recovery submission returns an **identical** response — same status, same
body, same shape — regardless of whether the address exists, is verified, is
rate-limited, or is malformed in a way that still parses as an email.

Sources of leakage that must all be closed, not just the obvious one:

- **Status and body.** One response. The existing register route's deliberately
  non-committal `202` body is the right register of language.
- **Timing.** An existing account does password-hash work and a lookup; a
  non-existent one may do neither. Unless the work is equalised, response time
  distinguishes them. This must be measured, not assumed — an unmeasured
  constant-time claim is a check that cannot fail.
- **Error paths.** A validation error, a database error or a send failure must
  not surface a different status. A send failure in particular must be logged
  and retried internally, never reported to the submitter.
- **Logs.** No full email address, no token, no reset URL. The existing
  redaction list (`req.headers.cookie`, `authorization`, `password`, `token`)
  is the precedent; recovery adds its own fields to it rather than assuming
  coverage.

---

## Token requirements (AC2)

| Property         | Requirement                                                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Generation**   | Cryptographically random, not derived from the address, the timestamp or any account data.                                                                                                              |
| **Storage**      | **Hashed at rest**, like a password. A database disclosure must not yield usable reset tokens.                                                                                                          |
| **Expiry**       | Short and absolute, measured from issuance. Not sliding, not refreshed by use.                                                                                                                          |
| **Single use**   | Consumed atomically on the first successful use. Two concurrent redemptions must result in exactly one success — a read-then-write check has a race and is not sufficient.                              |
| **Replay**       | A consumed or expired token is rejected with the **same** response as an invalid one. "Expired" and "invalid" must not be distinguishable, or expiry becomes a probe for whether a token was ever real. |
| **Scope**        | Resets one credential for one account. It is not a session, does not authenticate other actions, and does not elevate.                                                                                  |
| **Invalidation** | Issuing a new token invalidates outstanding ones. Any completed reset invalidates all of them.                                                                                                          |

---

## Origin and link handling (AC2)

- The reset link's origin is **taken from server configuration, never from the
  request**. A `Host` or `X-Forwarded-Host` header echoed into an email body is
  a token-exfiltration primitive: the attacker submits the victim's address, the
  victim receives a genuine email from the real sender, and the link points at
  the attacker.
- No open redirect after reset. The post-reset destination is a fixed internal
  path, not a caller-supplied `next`.
- The token travels in the request body or path, **never in a query string that
  survives into a referrer header** on the reset page.
- The reset page loads no third-party resources, so no external origin observes
  a URL containing the token.

## Session invalidation (AC2)

A completed reset must **invalidate every existing session for that account**,
not merely the one performing the reset. Recovery's main legitimate use is
suspected compromise; leaving the attacker's session alive defeats the purpose
entirely. Verification is not "the user can log in with the new password" — it
is that a session established _before_ the reset no longer works.

### An authenticated password change must also kill outstanding reset tokens

This is the one realistic sequence where the two surfaces interact, and it runs
in the direction the paragraph above does not cover.

An attacker submits the victim's address, so a **live reset token** now exists.
The victim, suspecting compromise, does the sensible thing and changes their
password through the **authenticated** route — which today knows nothing about
recovery. The attacker's token is still valid, and the change the victim just
made has done nothing to it.

> **A password change through any route invalidates all outstanding reset
> tokens for that account.** A recovery token is an alternative proof of
> ownership; changing the credential must retire every outstanding proof, not
> only the sessions.

This matters more than it first appears, because **it is precisely what a
compromised owner will actually do.** They will not think to cancel a reset
email they never requested.

---

## Verification lifecycle

- An unverified address may **receive** a verification message and nothing else.
- Verification tokens carry the same properties as reset tokens above.
- **Verification state must not leak through any other surface.** If an
  unverified account behaves observably differently at login, that difference is
  an enumeration oracle reachable without touching recovery at all.
- Changing an address de-verifies it, and must not be usable for recovery in the
  window before re-verification.

### Verification fixtures

The claim above — that an unverified account behaving observably differently at
login **is** an enumeration oracle reachable without touching recovery at all —
is the sharpest statement in this document, and it had no fixtures. A claim that
sharp with nothing to falsify it is the weakest kind of assertion.

| Case                                              | Required                                 |
| ------------------------------------------------- | ---------------------------------------- |
| Login, verified account, wrong password           | Response A                               |
| Login, **unverified** account, wrong password     | **Byte-identical to A**                  |
| Login, **non-existent** account, any password     | **Byte-identical to A**                  |
| Verification token reused                         | Rejected, indistinguishably from invalid |
| Verification requested for a non-existent address | Identical response; nothing sent         |

The first three must be compared **to each other**, byte for byte, in the same
test. Asserting each is a 401 separately passes while all three carry different
bodies — the same trap as the recovery non-enumeration fixture, on a surface
nobody thinks of as part of recovery.

---

## Fixtures the implementation must satisfy (AC2)

| Class     | Case                                              | Required                                                                                                                                                                                                                                                                                                |
| --------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Positive  | Valid address, valid token                        | Reset succeeds; prior sessions dead                                                                                                                                                                                                                                                                     |
| Positive  | Valid request for a **non-existent** address      | **Identical response**; nothing sent                                                                                                                                                                                                                                                                    |
| Malformed | Unparseable address, absent body, oversized field | Identical response; no crash; no send                                                                                                                                                                                                                                                                   |
| Malformed | Token of wrong shape / wrong length               | Rejected as invalid, indistinguishably from expired                                                                                                                                                                                                                                                     |
| Abuse     | Same token redeemed twice                         | Exactly one success, concurrently as well as sequentially                                                                                                                                                                                                                                               |
| Abuse     | Rate limit exceeded                               | **`202`, not `429`**; nothing sent. **BLOCKED — unwritable today**, alongside the control it tests: there is no usable rate-limit key until CS-59 is fixed, so this fixture cannot be written before the limiter it asserts on exists. Marked here rather than listed as if it were merely outstanding. |
| Abuse     | Forged reset origin via `Host` header             | Link uses the configured origin                                                                                                                                                                                                                                                                         |

**Traps, carried forward from CS-42 and CS-43:**

- **Every negative needs a positive on the same surface in the same test.** "No
  email was sent to the foreign address" passes trivially against a build that
  sends nothing to anybody. The real address must receive one in the same test.
- **The non-enumeration test must compare two responses byte for byte**, not
  assert each is `202` separately. Two `202`s with different bodies both pass a
  per-response assertion and still leak.
- **The single-use test must run concurrently.** A sequential double-redemption
  passes against an implementation with a read-then-write race, which is the
  defect actually worth catching.
- **The origin test must supply a hostile `Host` header and assert the emitted
  link.** Asserting the link is well-formed proves nothing about whose host it
  contains.

---

## Approval gate (AC3)

Not a formality. Before **any** implementation:

1. **Sender and domain** — an approved address on an approved domain, with SPF,
   DKIM and DMARC. An unauthenticated sender makes phishing the victim's
   recovery trivially easy and damages the domain's reputation.
2. **Secret handling** — where the provider credential lives, who can read it,
   how it rotates. It must never enter the repository, a log or a public build.
3. **Security design** — this document, reviewed, with the CS-59 blocker closed.
4. **Registration stays disabled** throughout. Enabling recovery is not
   permission to enable sign-up.

Until all four hold, the correct state is exactly the current one: authenticated
password change for owners with a session, operator recovery for those without.

---

## What is not done

No implementation, and **no fixtures written** — AC2 is specified, not tested.
AC1 and AC3 are met by this document.

**This ticket stays in DISCOVERY**, and is additionally **blocked on CS-59**:
the bounded-attempts criterion cannot be honestly satisfied while every client
shares one rate-limit key. Recording that dependency is the most useful output
of this ticket, because it was not visible from the acceptance criteria and
would have been discovered mid-implementation, or not at all.
