# CareerScope Engineering Entry Point

Follow the existing [engineering contract](.github/copilot-instructions.md).
This file is a navigation layer for tools that discover `AGENTS.md`, not a
second copy of that contract or a grant of additional permissions.

- Start with [project state](docs/PROJECT-STATE.md), then the affected stack's
  architecture and source. V1 and V2 coexist; do not infer deployment from HEAD.
- Use the [repository-local Copilot setup](docs/ai/README.md),
  [agent/skill mapping](docs/ai/agent-matrix.md), and
  [architecture index](docs/architecture/README.md).
- Preserve user edits and exclusive file claims. Parallel builders require
  explicit approval, disjoint claims and a dependency graph; shared files and
  mutable test resources serialize.
- Invoke only real allowlisted specialists. Manual handoffs are user transitions;
  validators do not schedule agents. No simulated participants or review evidence.
- Follow applicable scoped instructions and existing skills. Do not install
  tools, add servers, use paid APIs/external CLIs, or expand permissions as a
  workaround for missing capability.
- Use [testing guidance](docs/TESTING.md) and the
  [evidence gates](docs/ai/quality-gates.md). `check` is not `ready`; completion
  needs all applicable current-content evidence and independent review.
- Keep secrets, real environment files and personal data out of context and
  reports. No shipping action is authorized by a prompt or passing validator.
