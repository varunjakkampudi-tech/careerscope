# Engineering Limitations

This is the source of truth for engineering-OS limitations, not a replacement
for [product limitations](../KNOWN-LIMITATIONS.md). [Capabilities](capability-matrix.md)
records availability; [baseline](baseline.md) records pre-change results. An
unknown is not a pass, and a recorded limitation is not permission to ignore it.

| Limitation                                                             | Consequence and closure evidence                                                                                                                           |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No autonomous background scheduler                                     | Operator/Copilot performs the [loop](workflow.md); scripts validate, handoffs require user action                                                          |
| SessionStart and Agent Sessions UI unverified                          | Observe real events/session isolation in VS Code before claiming integration; unit tests are insufficient                                                  |
| Tool grants and file claims are not a sandbox                          | Shell can write outside claims; use isolated resources and review actual changed scope                                                                     |
| Attributed records, not signed attestations                            | JSON and digests cannot authenticate a reviewer or prove a test ran; inspect actual invocation/output                                                      |
| Schema 2 does not upgrade legacy records                               | Real replayable history is required; original schema-1 records retain LEGACY_previous implementation assurance, not fabricated transitions                 |
| Historical baseline is not a contract baseline                         | Preserved baseline.json has the QA-report shape, not strict `{schemaVersion, failures}`; a separate compatible record requires authorized, actual evidence |
| Runner is bounded execution, not authorization or isolation            | Fixed IDs invoke mutable scripts; review side effects and permission separately. Records and output hashes are not signed attestations                     |
| Historical metadata failure                                            | Baseline `check-customizations.mjs` rejected review metadata; current status needs a fresh check, and the parent owns the append-only record               |
| Completion intentionally incomplete                                    | Baseline `verify` refusal is correct; neither documentation nor passing `check` closes acceptance                                                          |
| Windows/Mac path mismatch and unsupported default Node                 | Use actual Windows workspace and existing pinned runtime; do not copy machine-specific paths blindly                                                       |
| Dirty shared tree; one observed worktree                               | Literal disjoint claims and serialized integration; no automatic branching or blind merges                                                                 |
| MCP and browser availability is not health                             | Scoped successful calls/tests needed; no credential inspection or new services to bypass blockers                                                          |
| Token/provider latency telemetry unavailable                           | Report unknown; timestamps do not measure model latency or cost                                                                                            |
| Baseline excludes CareerScope integration, browser and live provenance | Fresh isolated runtime evidence is still required for affected product claims                                                                              |

## Historical Risks

[Initial audit](initial-repository-audit.md) preserves release/CI/product findings.
They were not deeply re-audited for this documentation task and are **unverified
current**, not silently resolved. The current assignment changes no application,
production configuration, gate authority or security invariant. See
[troubleshooting](troubleshooting.md#drift-outside-this-assignment) for out-of-scope
documentation drift and the audit for agent-policy conflicts.

No new server, extension, dependency, paid API or external CLI is authorized.
R5 human approval remains mandatory; no green check grants shipping authority.
