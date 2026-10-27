# CareerScope Web

Private Next.js workspace for authenticated search, matching evidence and candidate
profiles. See the [repository run instructions](../../README.md) for prerequisites.

From the repository root:

```sh
npm run build
npm run start:web
```

Use http://localhost:5280 consistently with the configured API origin. Fastify
runs separately on 5390; starting the preview does not create an owner or start
workers. Restart the preview after rebuilding to avoid stale asset manifests.

`npm run test:ui` uses the built preview with a synthetic database
and temporary API. Leave 5390 free for this check. Private responses must not
enter shared caches, and credentials/resumes must not enter client builds.

The deployed stack runs behind Caddy on a single host; see `infra` for the
production compose file and verification scripts. The
[architecture](../../docs/ARCHITECTURE.md) records implemented functionality and
explicitly labelled proposals.
