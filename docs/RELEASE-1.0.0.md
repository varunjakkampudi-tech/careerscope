# CareerScope v1.0.0

Release date: 2026-09-09.

## Scope

CareerScope is the new product name for Job Radar. Internal npm workspace names,
storage keys, API routes, database schema, and deployment service names remain
unchanged for compatibility. No account reset or data migration is required.

This release is prepared for local production-build verification. It is not a
remote deployment, and no domain, TLS certificate, or cloud resource was changed.

## Improvements

- Desktop filters scroll independently within the available viewport, including
  on short screens. Keyboard users can tab through the filters and reach the final control.
- Responsive filter instances have unique input IDs and associated labels.
- Range controls have a 40px interaction area, visible value-based fill, native
  keyboard controls, associated hints, and a forced-colors fallback.
- Leads defaults to 0% and preserves explicit URL filters. Search preferences
  remain independent and retain the existing 85% initial search threshold.
- CareerScope branding appears on sign-in, navigation, page metadata, and the
  install manifest. The footer identifies v1.0.0.
- Page titles identify the current route without including personal filter data.
  Manifest and icon URLs support root and subpath deployments.
- Private pages retain noindex/nofollow and restrictive robots instructions.
  Public SEO would require a separate public site, not indexing resumes or leads.

## Verification

Run these gates from the repository root:

```sh
npm run typecheck
npm test
npm run lint
npm run test:ui
npm audit --omit=dev --audit-level=high
```

The browser gate builds production assets and runs Chromium, Firefox, and WebKit
against isolated synthetic accounts and data. It checks widths 320, 390, 768,
1024, and 1440px, major routes, light/dark themes, keyboard skip navigation,
filter scrolling at 600px viewport height, slider keyboard behavior, duplicate
IDs, privacy metadata, lazy loading, and uncaught page errors. It saves screenshots
to the temporary directory printed by the script. It does not submit applications.

Browser checks are not a full WCAG certification or physical-device test.
Production TLS, proxy/container execution, backup restoration, and target-network
provider behavior remain deployment-specific gates in
[PRODUCTION-READINESS.md](PRODUCTION-READINESS.md).

## Artifacts

- Web assets: `apps/web/dist/`
- API runtime: `apps/api/dist/`
- Internal package builds: `packages/*/dist/`

Use [RUNBOOK.md](RUNBOOK.md) for a future production deployment. Never place the
local environment file, database, resumes, or recovery backups in public assets.
