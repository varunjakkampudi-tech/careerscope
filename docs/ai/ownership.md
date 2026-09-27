# Ownership

Canonical execution claims live in [.ai/engineering.json](../../.ai/engineering.json).
The [validator](../../scripts/engineering.mjs) owns parsing and conflict checks.
There is no shadow `ownership.yml`; [quality-gates.json](../../quality-gates.json)
remains the only gate authority. Role defaults in the [matrix](agent-matrix.md)
never expand an individual task claim.

## Literal Claims

Claims are repository-relative literal paths, not globs. Schema 1 permits files
or directories; schema 2 requires existing regular files through
`safeContractFile` (at most 1 MiB each). Validation normalizes separators, rejects
unsafe/private/generated paths and symbolic links, and checks conflicts
case-insensitively including directory ancestry. Schema-1 directory membership
participates in the objective-wide content digest. Narrow scope instead of
claiming the whole repository.

Schema-1 active conflicts concern IN_PROGRESS tasks. Schema 2 reserves claims
through ASSIGNED, IN_PROGRESS, WAITING, IMPLEMENTED, VERIFYING, REVIEW and
PASSED. Its declared changedPaths must be an exact subset of claimed files and
respect forbiddenPaths; this is not automatic detection of actual changed files.

A prose exclusion such as "docs/ai except baseline" is not machine claim
syntax. Enumerate owned files when another writer or preserved file occupies
the directory. Include generated output and mutable test resources in planning;
untracked side effects are still writes, even if the claim validator cannot see
them. Claims coordinate agents; they do **not** lock the filesystem or sandbox
terminal commands.

## Integration Rules

Only approved independent builders with disjoint claims may overlap. Reserve
manifests, lockfiles, shared contracts/styles and canonical records for one
writer. The Orchestrator records task state unless explicitly delegated. QA
and Performance must isolate mutable resources; review reads frozen content.

For this assignment the parent owns `.github`, package/state and review records;
the runtime builder owns its engineering scripts; this delegate owns only the
approved documentation. Baseline files stay untouched and completion evidence
is deferred to the parent. No silent takeover when another agent stalls.

On conflict: stop the overlapping write, preserve both changes, notify the
Orchestrator, narrow/reassign the claim and serialize integration. Recheck digest,
tests and independent review after integration. Never blindly merge, reset or
delete another agent's work. See [Git isolation](git-isolation.md).
