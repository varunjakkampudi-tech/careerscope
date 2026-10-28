# Architecture boundaries

The workspaces form a layered graph. `npm run architecture:check`
(`scripts/ci/check-architecture-boundaries.mjs`, part of `npm run check`) reads
the source imports of every workspace under `apps/*`, `apps/workers/*` and
`packages/*` and fails on any edge not listed here.

## Allowed dependency graph

An arrow means "may import".

```text
apps/api ─────────────┐
apps/workers/search ──┤──► core ─────────► resume ──► shared
                      ├──► providers ────► matching ─► shared
                      ├──► matching        (providers, core, resume and
                      ├──► resume           matching also import shared)
                      └──► shared

apps/web ──► providers, matching, resume, shared      (never core: rule 7)
```

The apps import `matching` and `providers` directly, not through `core`: `core`
itself imports only `shared` and `resume`. Those direct edges are allowed and appear
in the table below.

| Workspace              | May import                                          |
| ---------------------- | --------------------------------------------------- |
| `shared`               | nothing internal (third-party packages only)        |
| `matching`             | `shared`                                            |
| `resume`               | `shared`                                            |
| `providers`            | `shared`, `matching`                                |
| `core`                 | `shared`, `resume`                                  |
| `api`, `search-worker` | `shared`, `core`, `matching`, `providers`, `resume` |
| `web`                  | `shared`, `matching`, `providers`, `resume`         |

## Rules the checker enforces

1. A package never imports an app, by package name or by relative path.
2. An app never imports another app.
3. `shared` imports no internal package.
4. `providers`, `matching` and `resume` never import `core`. Domain logic must stay
   usable without the database and queue layer.
5. Any other edge outside the table above is rejected (for example `matching`
   importing `providers`).
6. A non-test module never imports a test file (`*.test.*`, `*.spec.*`, or a file
   in a `__tests__` directory), including through a dynamic `import()`.
7. `web` never imports `core`: it must not depend on the database, queue and
   server-side layer. Three components still import types from it
   (`job-search-view.tsx`, `match-evidence.tsx`, `profile-editor.tsx`, all
   `import type`, erased at build time). They are listed in `WEB_CORE_BASELINE` and reported
   as warnings; any other web import of `core` fails. Move those types to `shared` and
   delete the baseline entries.

Test files themselves are held to rules 1 to 5 and 7 but may import other test files.
Directories named `node_modules`, `dist`, `dist-types`, `.next` and `__fixtures__`,
and `.d.ts` files, are skipped. `scripts/` and `tests/` are not workspaces and are
not scanned; they may import from any package.

## Scope and limits

- Comments are stripped by a small scanner that leaves string literals alone, so a
  `/*` inside a string cannot hide a later import. A regex literal containing a quote
  can still confuse it within one line.
- Imports are found by pattern (`import ... from`, `export ... from`, side-effect
  `import`, `import()` and `require()` with a string literal). A computed
  specifier cannot be analysed and is not checked.
- Relative imports that leave a workspace are attributed to the workspace that
  owns the target path.
- `package.json` dependency declarations are not compared with imports; the
  checker looks only at source files.

## Changing the graph

Edit `ALLOWED` in `scripts/ci/check-architecture-boundaries.mjs`, its test, and
this document in the same change, with the reason for the new edge.
