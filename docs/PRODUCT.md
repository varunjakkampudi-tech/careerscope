# Product

CareerScope helps one candidate discover legitimate job postings, understand
deterministic match evidence, save opportunities and track application
progress. The candidate remains in control of every lifecycle transition.

Supported product areas are dashboard, job discovery/details, saved jobs,
profile/preferences, private resumes, preparation/resources and application
tracking. Unknown provider data remains unknown; no employer or ATS event is
fabricated. Autonomous apply, credential scraping and CAPTCHA bypass are out
of scope.

## Product profile

| Area               | Current state                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Product / company  | CareerScope / Viswatra                                                                                                                     |
| Web and API        | Next.js App Router, React and TypeScript; Fastify; PostgreSQL with Drizzle                                                                 |
| Async and storage  | Transactional outbox, private Redis/BullMQ, publisher, search and files workers, encrypted private resume files                            |
| Hosting            | Single-host Docker and Caddy configuration; see [DEPLOYMENT](operations/DEPLOYMENT.md). No live deployment is inferred from the repository |
| Roles              | Candidate journeys are implemented; recruiter, admin and super-admin roles are planned. The admin test label is not staff authorization    |
| Languages          | English UI today; Telugu and Hindi are planned and localization is incomplete                                                              |
| Browser targets    | Chromium, Firefox and WebKit; real Android Chrome, iOS Safari and screen-reader acceptance is tracked separately                           |
| Layout targets     | 320 to 1920 px wide, portrait and landscape, 200% and 400% zoom                                                                            |
| Public SEO         | The private workspace is `noindex`; public job pages require rights-cleared content                                                        |
| Data classes       | Identity and session secrets; private profile, preference, resume and application records; source and job data; operational and audit data |
| Providers          | See [PROVIDERS](PROVIDERS.md); optional integrations stay disabled until their gates pass                                                  |
| Recovery           | One-hour RPO and four-hour RTO targets; see [BACKUP](operations/BACKUP.md)                                                                 |
| Native mobile apps | Not part of the current product; mobile-browser behaviour is validated instead                                                             |
