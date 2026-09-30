---
description: 'Use when writing or reviewing repository documentation, architecture diagrams, setup guidance, prompts or human-facing engineering projections.'
applyTo: 'README.md,AGENTS.md,docs/**/*.md,START-HERE/**/*.md,.ai/*.md,.github/prompts/careerscope-*.prompt.md'
---

# Documentation Engineering

- Read affected source before asserting behavior. Distinguish historical evidence from the canonical CareerScope product,
  target design from implemented code, and local source from live deployment.
  Link [project state](../../docs/PROJECT-STATE.md); do not repeat version or
  source-count claims without checking their current authority.
- Preserve useful existing content and caveats. Prefer a link over another
  copy. Keep the task's file ownership boundary: record out-of-scope drift as a
  finding rather than editing application code or unrelated documentation.
- Verify paths, commands and links. Commands seen in manifests are an inventory,
  not evidence that they ran. Never invent test totals, agent participants,
  production readiness, a runtime model or unavailable validator schema fields.
- Keep diagrams source-linked and scoped. Show actual data/control boundaries;
  explicitly label target workflow versus implemented runtime. Mermaid source
  alone is not proof that the rendered diagram was inspected.
- Follow [native agent semantics](../../docs/ai/agent-system.md): real allowlisted
  subagent calls, user-triggered handoffs, manual/session fallback, and scripts
  that validate rather than schedule. Hooks are preview and tools are not an
  OS sandbox. Execute-capable QA is not read-only by capability.
- Check the first edited document promptly, then format/check only owned files.
  Report exact commands and remaining verification gaps. Do not run broad
  formatters over concurrent work. Do not read secrets, environment files,
  resumes or personal data to enrich documentation.
- Record current-content evidence, not historical green claims. Append authorized
  review snapshots; never overwrite history or turn a progress projection into
  the product backlog. Release preparation is not shipping authorization.
