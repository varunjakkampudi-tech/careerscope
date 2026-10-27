# Product surface

This describes repository routes, not deployment acceptance. The Next.js app
in `apps/web/src/app` is the sole web client.

| Route               | Responsibility                               |
| ------------------- | -------------------------------------------- |
| `/`                 | Account/sign-in entry                        |
| `/dashboard`        | Candidate workspace and profile/search entry |
| `/jobs`             | Job search and results                       |
| `/saved`            | Saved and archived jobs, notes and history   |
| `/applications`     | Explicitly tracked application records       |
| `/resume`           | Private resume upload and processing         |
| `/preparation`      | Preparation surface                          |
| `/career-resources` | Resource links                               |
| `/settings`         | Password and session controls                |

Authenticated routes share the application shell and typed API client.
Provider data, scores and saved state come from real service responses.
Missing data is displayed honestly; illustrative design metrics are never
production seed data. External job destinations do not change application status.

Approved designs also describe future surfaces. A design reference does not
establish a working route, enabled provider, or released capability. Consult
[Product](PRODUCT.md), [Providers](PROVIDERS.md), [Application tracking](APPLICATIONS.md)
and [Known limitations](KNOWN-LIMITATIONS.md) for the runtime boundaries.
