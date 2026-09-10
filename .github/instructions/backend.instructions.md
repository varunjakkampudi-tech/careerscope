---
name: CareerScope Backend And Domain
description: 'Use when changing API/MCP routes, repositories, matching, resume parsing, providers or workers: contracts, validation, concurrency and failure handling.'
applyTo: 'apps/api/src/**,packages/providers/src/**,packages/matching/src/**,packages/resume/src/**,packages/shared/src/**'
---

# Backend And Domain Rules

- Keep Fastify routes thin and dependencies explicit through the existing container.
  Reuse shared Zod schemas, repository abstractions and typed API errors.
- Validate external input and authentication/authorization at every entry point,
  including MCP. Test singular/plural filter mappings, defaults and unknown inputs.
- Preserve existing SQLite transactions, migration conventions and deduplication.
  Check constraints and query plans before adding indexes or caching. Never test
  migrations or seed scripts against the owner's data directory.
- Distinguish deterministic matching from optional network reranking. Preserve
  exclusion rules, snippet-confidence limits and truthful evidence for skills,
  seniority, salary, location and posting dates.
- Reuse provider HTTP normalization, timeout, retry and cancellation controls.
  Surface partial results, rate limits and unsupported/unconfigured providers.
  A fixture passing does not prove live portal access.
- Keep application approvals, consent, cancellation and durable state transitions
  explicit. Preserve uncertain-outcome and duplicate-submission guards across
  retries, reloads and restarts; confirmation is required before Applied status.
- Use structured redacted logging and safe client-facing errors. Preserve request
  IDs, bounded external calls, readiness checks and graceful shutdown behavior.
- Browser imports keep canonical source IDs/URLs and provenance, not full mailbox
  bodies or tracking tokens. Keep stronger existing descriptions, notes and statuses.
- Add focused boundary and failure tests; verify persisted state as well as response
  shapes. Keep exported types and API/MCP contracts backward compatible when required.
