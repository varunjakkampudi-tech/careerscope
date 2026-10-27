# Documentation

This is the single index of CareerScope documentation. Every document under
`docs/` is linked here.

## Product and architecture

- [PRODUCT](PRODUCT.md) - supported journeys, boundaries and product profile
- [PRODUCT-SURFACE](PRODUCT-SURFACE.md) - routes and user-visible surface
- [APPLICATIONS](APPLICATIONS.md) - application tracking lifecycle
- [PROVIDERS](PROVIDERS.md) - job provider adapters and permitted use
- [ARCHITECTURE](ARCHITECTURE.md) - runtime topology and trust boundaries
- [FRONTEND-ARCHITECTURE](FRONTEND-ARCHITECTURE.md) and [FRONTEND](FRONTEND.md) - web client
- [API-SURFACE](API-SURFACE.md) - HTTP contracts
- [DATA-MODEL](DATA-MODEL.md) - persistence and ownership rules
- [KNOWN-LIMITATIONS](KNOWN-LIMITATIONS.md) - explicit current limitations
- [DOMAIN-EVENTS](architecture/DOMAIN-EVENTS.md) - event and message contracts, producers, consumers and delivery guarantees
- [DESIGN-SYSTEM](architecture/DESIGN-SYSTEM.md) - design tokens and shared web components

## Security and privacy

- [AUTHENTICATION](AUTHENTICATION.md) - local and private hosted test access
- [SECURITY](SECURITY.md) - security controls and review guidance
- [THREAT-MODEL](security/THREAT-MODEL.md) - threats and mitigations
- [PRIVACY](PRIVACY.md) - data classification and retention
- [AGENT-SECURITY](governance/AGENT-SECURITY.md) - private-data and untrusted-input boundaries
- [Privacy policy draft](legal/PRIVACY-POLICY-DRAFT.md) and
  [terms of service draft](legal/TERMS-OF-SERVICE-DRAFT.md)

## Decisions

- [CSP-STRICT-SCRIPT-SRC](decisions/CSP-STRICT-SCRIPT-SRC.md) - content security policy notes

## Testing and verification

- [TESTING](TESTING.md) - local and service-backed checks, test layout and naming
- [UI-VERIFICATION](UI-VERIFICATION.md) - browser and accessibility verification
- [2026-10-18 test access verification](evidence/2026-10-18-TEST-ACCESS-VERIFICATION.md) - dated evidence

## Operations

- [DEPLOYMENT](operations/DEPLOYMENT.md) - guarded manual deployment
- [ROLLBACK](operations/ROLLBACK.md), [BACKUP](operations/BACKUP.md) and [SECRETS](operations/SECRETS.md)
- [MONITORING](operations/MONITORING.md), [FIREWALL](operations/FIREWALL.md) and [PROXY-RECOVERY](operations/PROXY-RECOVERY.md)
- [HOSTINGER](operations/HOSTINGER.md) - host description and access
- [DISCOVERY-SCHEDULE](operations/DISCOVERY-SCHEDULE.md) and [LEAD-LIFECYCLE](operations/LEAD-LIFECYCLE.md)
- [CI-CD](operations/CI-CD.md) - CI workflow and its boundaries
- [MANUAL-CI-TESTING](operations/MANUAL-CI-TESTING.md) - running CI suites by hand
- [STAGING](operations/STAGING.md) - staging status and owner prerequisites
