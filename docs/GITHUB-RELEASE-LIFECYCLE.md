# GitHub release lifecycle

CareerScope keeps CI, deployment and release publication deliberately separate:

1. A push or pull request runs canonical CI.
2. An authorized operator manually runs `Deploy` for the current `main` HEAD.
3. Deployment verifies the exact SHA, migrations, health checks and provenance
   on the Hostinger production environment.
4. After production acceptance, an authorized operator manually runs `Release`
   with the full deployed SHA and a SemVer product version.
5. The release workflow verifies a successful production deployment for that
   SHA, verifies exact-SHA CI, refuses an existing tag, creates an annotated
   tag and publishes the GitHub Release.

The release workflow is manual-only and fail-closed. A green CI run is not a
release, and a deployment that was not accepted is not a release. The first
canonical production release is planned as `v1.0.0`; it must not be created
until production deployment and acceptance gates actually pass.

Historical tags such as `v1.3.4` and `v3.0.0` remain immutable audit records of
earlier milestones. They are not active architecture labels and are not
rewritten or repointed.

The application version source remains the root `package.json`, synchronized to
the web and static-site version displays by `npm run version:sync`. API route
names such as `/api/v1/...` are protocol contracts, not product-version labels.
