# API test entry point

The API's HTTP-level integration tests live in the shared database harness at
[`packages/core/src/database.test.ts`](../../packages/core/src/database.test.ts).
That file drives the API app with `app.inject()` and is executed by the root
`test:integration` script. Keep this pointer beside the API source so a reader
finds the authoritative test surface instead of creating a duplicate suite.

The current integration command names eight test files. This pointer does not
move or weaken any assertions; it documents the existing discovery path.
