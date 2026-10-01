# Performance report

The repository contains valid historical regression and soak evidence. These
figures are from `docs/PRODUCT-ACCEPTANCE.md` (September 18, 2026), not a
production SLO and not a fresh run on the current host.

| Metric                      | Measured                                                                                        | Threshold                                              | Verdict                   | Evidence                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------- | ------------------------------------------------------------- |
| Authenticated read p50/p95  | searches 4.38/12.22 ms; leads 4.38/4.95 ms; profile 3.69/5.30 ms; preparation 4.07/5.54 ms      | Regression guard only                                  | PASS at recorded revision | `docs/PRODUCT-ACCEPTANCE.md`, Event Retention And Performance |
| 8-concurrent sustained load | 20,252 requests; 0 failures; 675 req/s; p50 11.35 ms; p95 16.9 ms; p99 21.86 ms; RSS 266→351 MB | p95 <500 ms; p99 <1000 ms; no failures; bounded memory | PASS at recorded revision | Same source; single-host workload                             |
| 30-minute mixed-load soak   | 1,807,830 ms; 34,102 operations; 0 failures; peak RSS 239,149,056 bytes                         | Stability/cleanup assertions; no production SLO        | PASS at recorded revision | Same source; disposable single-host soak                      |

Declared workload: 8 concurrent readers, 30s, authenticated read routes, zero
failures, explicit p50/p95/p99 thresholds --
`node data/windows-v2/run.mjs run test:performance`.

These are single-host figures on a 2 vCPU development/VPS-like environment. They are a regression guard,
**not a production SLO**.

No fresh performance run was executed in this cycle because the local Docker
service environment is unavailable. Production latency, capacity and real-host
resource behaviour remain unmeasured.

**Verdict:** Historical regression evidence recorded; production SLO
certification pending representative hosted measurement.
