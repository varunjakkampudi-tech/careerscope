# Architecture boundaries

The workspaces form a layered graph. `npm run architecture:check`
(`scripts/ci/check-architecture-boundaries.mjs`, part of `npm run check`) reads
the source imports of every workspace under `apps/*`, `apps/workers/*` and
`packages/*` and fails on any edge not listed here.

## Allowed dependency graph

An arrow means "may import".

```text
apps/api            ─┐
apps/web             ├─►  core ─► resume ─► shared
apps/workers/search ─┘      │                  ▲
                            └──────────────────┤
              providers ─► matching ───────────┤
                   └───────────────────────────┘
```

| Workspace                     | May import                                          |
| ----------------------------- | --------------------------------------------------- |
| `shared`                      | nothing internal (third-party packages only)        |
| `matching`                    | `shared`                                            |
| `resume`                      | `shared`                                            |
| `providers`                   | `shared`, `matching`                                |
| `core`                        | `shared`, `resume`                                  |
| `api`, `web`, `search-worker` | `shared`, `core`, `matching`, `providers`, `resume` |

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

Test files themselves are held to rules 1 to 5 but may import other test files.
Directories named `node_modules`, `dist`, `dist-types`, `.next` and `__fixtures__`,
and `.d.ts` files, are skipped. `scripts/` and `tests/` are not workspaces and are
not scanned; they may import from any package.

## Scope and limits

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
