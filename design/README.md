# CareerScope Design Source of Truth

`design/` contains tracked visual references and design tooling for CareerScope.
It is an engineering reference area; production routes do not load screenshots
or HTML from this directory at runtime.

## Canonical ownership

- `design/brand/` is reserved for approved brand identity assets.
- `design/foundations/` is reserved for locked visual tokens and usage guidance.
- `design/pages/` is reserved for approved page references, grouped by surface.
- `design/archive/` holds superseded references that remain useful for history.
- `design/concepts/` contains unapproved exploration and is not a product
  specification.
- `design/home-variants/` contains a reviewable static design prototype and its
  builder; it is not a production route or runtime dependency.

Only directories containing real, reviewed assets are created. Empty future
page directories are intentionally omitted.

## Approval and naming

An asset is not canonical merely because it is committed. A design becomes
`LOCKED` or `APPROVED` only after the owner/design review records that decision
in the relevant engineering evidence. Until then, inventory it as `IN REVIEW`
or `NOT DESIGNED`.

Use descriptive, surface-based names such as:

```text
pages/dashboard/careerscope-dashboard-desktop.png
pages/dashboard/careerscope-dashboard-mobile.png
```

Use `desktop` and `mobile` suffixes for viewport references. Do not use
`final.png`, `latest.png`, or numbered final iterations. Superseded approved
assets belong under `archive/`; rejected or reproducible experiments should not
be committed.

## Design inventory

| Surface                  | Desktop                           | Mobile       | Status       | Implementation                       |
| ------------------------ | --------------------------------- | ------------ | ------------ | ------------------------------------ |
| Marketing/home prototype | `home-variants/refined-dark.html` | Not provided | IN REVIEW    | `apps/web` public route              |
| Dashboard                | Not provided                      | Not provided | NOT DESIGNED | `apps/web` dashboard route           |
| Jobs                     | Not provided                      | Not provided | NOT DESIGNED | `apps/web` jobs route                |
| Applications             | Not provided                      | Not provided | NOT DESIGNED | `apps/web` applications route        |
| Profile/resume           | Not provided                      | Not provided | NOT DESIGNED | `apps/web` profile and resume routes |
| Settings                 | Not provided                      | Not provided | NOT DESIGNED | `apps/web` settings route            |

The exploratory images under `concepts/` are retained as explicitly
unapproved references. They must not be represented as approved product design
or used as a runtime asset dependency.

## Review workflow

1. Add a descriptive reference under the relevant page or foundation folder.
2. Record viewport, provenance, and review status in the design inventory.
3. Implement the approved direction with React, Next.js, CSS and runtime assets
   under the application that owns the route.
4. Validate responsive, keyboard, accessibility and visual behavior.
5. Move superseded but useful references to `archive/`; remove rejected or
   reproducible generated experiments.
