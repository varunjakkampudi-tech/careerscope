# CareerScope documentation

Use [PROJECT-STATE](PROJECT-STATE.md) as the current product and deployment
truth. The other documents are scoped references and must not describe planned
or historical behaviour as deployed functionality.

## Current contracts

- [ARCHITECTURE](ARCHITECTURE.md) — runtime boundaries and invariants
- [Architecture diagrams](architecture/README.md) — current system and flow maps
- [GitHub release lifecycle](GITHUB-RELEASE-LIFECYCLE.md) — manual release and provenance contract
- [FRONTEND-ARCHITECTURE](FRONTEND-ARCHITECTURE.md) — Next.js route and UI boundaries
- [API-SURFACE](API-SURFACE.md) — authenticated HTTP contract
- [PRODUCT-SURFACE](PRODUCT-SURFACE.md) — supported user journeys
- [SECURITY](SECURITY.md) — controls, threat review and open findings
- [PRIVACY](PRIVACY.md) — runtime data boundaries and agent/Copilot handling
- [TESTING](TESTING.md) — commands and evidence standards
- [KNOWN-LIMITATIONS](KNOWN-LIMITATIONS.md) — explicit residual limitations
- [Design source of truth](../design/README.md) — visual references, approval status and implementation ownership

## Operations

Operational runbooks are under [OPERATIONS](OPERATIONS/):

- [Deployment](OPERATIONS/DEPLOYMENT.md)
- [Rollback](OPERATIONS/ROLLBACK.md)
- [Hostinger](OPERATIONS/HOSTINGER.md)
- [Firewall](OPERATIONS/FIREWALL.md)
- [Secrets](OPERATIONS/SECRETS.md)
- [Backup](OPERATIONS/BACKUP.md)

## History and evidence

`docs/archive/` contains superseded plans and historical runbooks retained for
traceability. Append-only release reviews and `.ai/` ticket/evidence records
are also historical unless a document explicitly identifies itself as current.
Do not use an archived report as proof of the current deployment.

## Canonical reading path

New engineers should read `README.md`, then this index, then the relevant
architecture, testing, security or operations contract. Release-specific CI
runs, ticket evidence and historical migration notes are evidence records,
not alternate product instructions.
