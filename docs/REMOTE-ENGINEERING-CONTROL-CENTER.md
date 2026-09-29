# Remote Engineering Control Center (CS-45)

## Decision

The remote control center is a **manually published, read-only encrypted
snapshot** of the local engineering dashboard. It is a Pages artifact, not a
server, API, webhook, or live connection to the workstation. The existing
loopback `scripts/engineering-ui.mjs` remains the source of truth and keeps its
local-only contract.

The export reuses the existing `mobile-site/admin.enc.json` envelope and the
`docs/ENCRYPTED-ADMIN.md` publication workflow. A separate asset name (for
example `engineering.enc.json`) prevents the engineering snapshot from being
confused with the private lead snapshot and lets the Pages allowlist reject an
accidental substitution.

## Snapshot contract

The exporter reads the validated state readers used by the local control center
and writes only an allowlisted projection:

- ticket id, title, status, priority, area, release target, current step,
  dependency ids, and updated-at date;
- aggregate progress percentages and counts; and
- agent/loop status names and timestamps, when present in `LOOP-STATE.json`.

It must not include secrets, credentials, passphrases, resume/profile content,
lead records, hostnames, private URLs, raw findings, command output, or
verbatim exploit details. Unknown fields are rejected rather than copied. The
projection is schema-versioned and carries `exportedAt`, `sourceCommit`, and
`schemaVersion` so the client can display provenance and refuse unsupported
versions.

The exporter must fail closed when any source JSON is malformed or when the
projection contains a field outside the allowlist. It never edits source state,
creates a plaintext export, or pushes by itself. Publication remains an
explicit `pages:publish` operation using a passphrase supplied locally and
never sent to GitHub.

## Read-only browser behavior

The Pages view decrypts in memory only, using the same Web Crypto and inactivity
rules as the existing encrypted admin surface. It shows a prominent
“Last exported” timestamp and source commit before rendering any ticket data.
If the snapshot is stale according to a visible, documented threshold, the UI
shows a warning; it does not imply that the local dashboard is current. Lock,
refresh, storage-blocked, wrong-passphrase, tampered-envelope, and unsupported
schema states are explicit and do not leak whether a particular ticket exists.

The remote view can filter and search tickets, but it cannot create, edit,
reorder, transition, or delete tickets. It has no GitHub token, write API,
form submission endpoint, service worker, polling loop, or background task.

## Separate write-path decision

Remote ticket creation/editing is intentionally **not** part of CS-45. A future
write ticket must define owner authentication, replay protection, optimistic
revision checks, an append-only audit trail, conflict recovery, and a bounded
sync back to the git-tracked backlog (or an explicitly approved replacement
store). Until that design and security review are accepted, the only write
path is the local engineering workflow and normal reviewed git changes.

## Verification plan

Before implementation is promoted, the following evidence is required:

1. Unit tests prove the allowlist, schema-version rejection, malformed-source
   failure, and absence of secrets/private fields using paired positive and
   negative fixtures.
2. Browser tests prove decrypt/lock/refresh, stale timestamp warning,
   unsupported/tampered envelopes, keyboard navigation, responsive layouts,
   and that no network request other than the static encrypted asset occurs.
3. The Pages staging checker proves the asset is explicitly allowlisted,
   `robots.txt` does not advertise it, and no plaintext engineering snapshot is
   present in the published tree.
4. A manual export/publish/revoke runbook is reviewed independently. No live
   Hostinger or VPS dependency is introduced by this read-only design.

This document completes the discovery decision for CS-45. Implementation and
the separately gated remote write path remain follow-up work with their own
acceptance evidence.
