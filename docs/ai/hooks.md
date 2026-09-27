# Hooks

[engineering.json](../../.github/hooks/engineering.json) registers one
SessionStart command: `node scripts/engineering-hook.mjs`, with a 10-second
timeout. [engineering-hook.mjs](../../scripts/engineering-hook.mjs) reads input
from stdin and validates local engineering records. This is source-inspected
configuration; **real VS Code SessionStart firing remains unverified**.

## Implemented Behavior

The handler bounds input to 64 KiB, rejects malformed JSON and invalid UTF-8,
and permits only an object with an absent or matching SessionStart event name.
Invalid input/configuration yields exit 2 and `continue: false` with a generic
message. Valid incomplete/BLOCKED records yield exit 0 and a reminder that
completion is not verified; blocking every unfinished session would prevent
work from starting. Complete records are described as verified by local records
only, not product/runtime/deployment verification.

It does not echo hook payloads, change records, invoke agents, run arbitrary
task commands or enforce per-tool filesystem permissions. No PreToolUse,
PostToolUse or Stop hook is registered by this file. Hooks are preview assistance,
not a security sandbox or an autonomous scheduler.

[check-customizations.mjs](../../scripts/check-customizations.mjs) accepts the
exact SessionStart command/event/timeout and rejects changed or extra hook
configuration. Its latest-review metadata failure is separate from hook health.
[Hook tests](../../scripts/engineering-hook.test.mjs) exercise malformed input,
stream bounds, UTF-8 failure and fail-closed configuration. The
[baseline](baseline.md) includes these in 131 passing engineering/hook tests;
that total is pre-change evidence, not a claim about a concurrent runtime patch.

## Operator Verification Still Needed

Confirm trusted-workspace discovery and observe a real SessionStart result in
VS Code without printing payloads. The configured bare `node` inherits the host
environment: this Windows machine's default Node 22 is unsupported. A terminal
check using pinned Node 26 does not prove the hook process used it. Establish an
approved supported host runtime before claiming real hook integration; do not
edit user settings or install software as an implicit workaround.

Hook absence/failure must not bypass explicit validation and independent review.
See [quality gates](quality-gates.md), [limitations](limitations.md), and
[failure recovery](failure-recovery.md).
