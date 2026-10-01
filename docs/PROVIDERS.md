# Provider inventory

This inventory is derived from the provider registry, the search command schema
and the worker's runtime factory map. A provider being implemented in
`packages/providers` does not mean it is exposed by the R1 search API.

## R1 production search contract

The Fastify API and search worker currently accept exactly five sources:

| Source     | Classification      | Runtime evidence                                        |
| ---------- | ------------------- | ------------------------------------------------------- |
| Greenhouse | `ACTIVE_PRODUCTION` | `searchSourceSchema`, `providerFactories`, ATS adapter  |
| Lever      | `ACTIVE_PRODUCTION` | `searchSourceSchema`, `providerFactories`, ATS adapter  |
| Workable   | `ACTIVE_PRODUCTION` | `searchSourceSchema`, `providerFactories`, ATS adapter  |
| RemoteOK   | `ACTIVE_PRODUCTION` | `searchSourceSchema`, `providerFactories`, feed adapter |
| Himalayas  | `ACTIVE_PRODUCTION` | `searchSourceSchema`, `providerFactories`, feed adapter |

The worker applies per-source deadlines, normalization, deduplication and
failure isolation. A source outcome is persisted even when a source is empty or
fails, so partial collection is observable.

## Implemented but not in the R1 search contract

These adapters are maintained in the provider registry for controlled future
expansion, import/enrichment flows or isolated tests. They are not accepted by
`createSearchSchema` and cannot be selected by the deployed R1 search UI:

- Ashby, SmartRecruiters and Recruitee: implemented ATS adapters, not exposed
  by the current R1 search contract.
- Adzuna, Jooble and JSearch: credentialed aggregator adapters, not exposed by
  the current R1 search contract.
- LinkedIn, Naukri and Indeed: browser-backed, opt-in adapters. They remain
  disabled from R1 search because legitimate access and provider acceptance are
  not established. No cookie/session scraping or access-control bypass is
  permitted.
- Gmail: a separate read-only job-alert processing provider, not a search
  source.

## Provenance-only/deferred identifiers

`foundit` and `cutshort` remain in the shared provenance vocabulary for
historical/imported records. They have no runtime provider factory. Naukri is
explicitly deferred unless a legitimate provider contract is approved.

This separation prevents documentation from advertising adapters that the API
does not actually expose and keeps future provider work behind an explicit
contract, tests, rate-limit review and product acceptance.
