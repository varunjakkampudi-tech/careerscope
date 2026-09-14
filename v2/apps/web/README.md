# CareerScope v2 Web

Private Next.js workspace for authenticated search, matching evidence and candidate
profiles. See the [v2 run instructions](../../README.md) for prerequisites.

From the repository root:

```sh
npm --prefix v2 run build
npm --prefix v2 run start:web
```

Use http://localhost:5280 consistently with the configured API origin. Fastify
runs separately on 5390; starting the preview does not create an owner or start
workers. Restart the preview after rebuilding to avoid stale asset manifests.

`npm --prefix v2 run test:ui` uses the built preview with a synthetic database
and temporary API. Leave 5390 free for this check. Private responses must not
enter shared caches, and credentials/resumes must not enter client builds.

Cloud deployment is deferred to v3. The [architecture](../../ARCHITECTURE.md)
distinguishes the Docker-first target from implemented functionality.
