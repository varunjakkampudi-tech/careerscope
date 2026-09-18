# QA report

_Nothing run for an active task._

Real command output only. A model asserting that something passed is not a
result; neither is a zero exit code on its own.

| Check         | Command                                      | Result | Evidence |
| ------------- | -------------------------------------------- | ------ | -------- |
| Format        | `npm run format:check`                       | -      |          |
| Lint          | `npm run lint`                               | -      |          |
| Typecheck     | `npm run typecheck`                          | -      |          |
| Root tests    | `npm test`                                   | -      |          |
| V2 typecheck  | `node data/windows-v2/run.mjs run typecheck` | -      |          |
| V2 lint       | `node data/windows-v2/run.mjs run lint`      | -      |          |
| V2 tests      | `node data/windows-v2/run.mjs test`          | -      |          |
| V2 build      | `node data/windows-v2/run.mjs run build`     | -      |          |
| Accessibility | axe, where the task touches UI               | -      |          |
| Smoke         | live checks, where the task affects runtime  | -      |          |

**Final status:** _pending_
