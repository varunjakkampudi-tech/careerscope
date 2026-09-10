---
name: CareerScope Frontend
description: 'Use when changing React routes, components, styling or the static Pages UI: state, accessibility, responsive behavior and browser compatibility.'
applyTo: 'apps/web/src/**,mobile-site/**'
---

# Frontend Rules

- Follow React 19, TypeScript, Vite, Tailwind and the existing UI primitives in
  `apps/web/src/components/ui`. Reuse Lucide icons and current design tokens.
- Keep this operational UI compact and useful for scanning jobs. Preserve visual
  hierarchy, theme behavior, focus visibility and consistent navigation; do not
  replace working screens with marketing layouts or unrelated visual redesigns.
- Use TanStack Query for server state and local state for transient UI choices.
  Invalidate affected queries after mutations; reset job-specific consent when
  switching leads. Do not add memoization or global state without a clear need.
- Cover pending, empty, error, disabled, success and uncertain-result states.
  Never use optimistic success for application submission or other irreversible work.
- Label controls, support keyboard interaction and logical focus restoration, use
  semantic landmarks/tables, and keep destructive actions explicitly confirmable.
- Check 320px mobile through desktop, long content and platform font differences.
  Keep controls stable and touch-accessible; avoid overlap and horizontal overflow.
- Preserve route-level lazy loading and inspect bundle/network effects for large
  dependencies. Apply SEO to public routes; retain privacy metadata for private ones.
- Treat email/job content as untrusted. Render text safely and sanitize outbound
  URLs. Never embed owner data, credentials or worker capabilities in public Pages.
- The React workspace and `mobile-site` are separate surfaces. Keep behavior and
  styling consistent where intended without implying static Pages has a backend.
- Test touched components and run relevant browser workflows, including Firefox
  and WebKit for layout/interaction changes. Review screenshots, not only DOM asserts.
