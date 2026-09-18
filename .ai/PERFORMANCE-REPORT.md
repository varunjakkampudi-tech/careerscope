# Performance report

_No measurements yet._

| Metric | Measured | Threshold | Verdict | Evidence |
| ------ | -------- | --------- | ------- | -------- |

Declared workload: 8 concurrent readers, 30s, authenticated read routes, zero
failures, explicit p50/p95/p99 thresholds --
`node data/windows-v2/run.mjs run test:performance`.

These are single-host figures on a 2 vCPU VPS. They are a regression guard,
**not a production SLO**.

**Verdict:** _pending_
