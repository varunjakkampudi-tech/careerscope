---
name: CareerScope Architecture And Operations
description: 'Use when designing significant features, changing ownership/data flow, dependencies, build structure, CI, containers or deployment.'
applyTo: 'apps/api/src/container.ts,apps/api/src/app.ts,apps/web/src/App.tsx,infra/**,.github/workflows/**,docs/ARCHITECTURE.md,**/package.json,**/tsconfig*.json'
---

# Architecture And Operations Rules

- Retain the modular monolith and workspace ownership. Explain any new service,
  queue, cache, abstraction or dependency using current requirements and evidence.
- For significant decisions, identify components, data flow, trust boundaries,
  compatibility, realistic capacity, failure recovery and operational cost. Prefer
  the smallest viable design and document consequential trade-offs.
- TypeScript references do not prove the absence of source-level dependency cycles.
  Review actual imports when modifying shared ownership or build dependencies.
- Public static Pages, authenticated API/UI, shared-browser handoff and isolated
  Copilot worker are distinct deployment/session boundaries. Do not merge their
  authentication assumptions or advertise unavailable runtime capabilities.
- Preserve release gates and allowlisted Pages staging. Verify the actual release
  version and deployed assets, not only a successful push or image build.
- Never trigger EC2, change enable flags or install system software without current
  approval. Deferred container checks remain deferred until executed on a real host.
- Before cloud enablement, pin the exact verified commit, choose the correct Compose
  target, test TLS/proxy readiness, non-root operation, limits, persistent sessions,
  restart behavior, backup/restore and rollback. Do not expose VNC publicly.
- See [architecture](../../docs/ARCHITECTURE.md),
  [runbook](../../docs/RUNBOOK.md) and
  [EC2 acceptance](../../docs/EC2-APPLICATIONS.md) for implementation context.
