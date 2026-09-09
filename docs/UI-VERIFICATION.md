# UI Verification

The application keeps its existing light/dark design tokens and dense workspace
layout. Shared improvements include a predictable responsive header, footer,
keyboard skip link, 40px header icon targets, safe-area gutters, reduced-motion
support, and matching browser-chrome colors when a theme is explicitly chosen.
The mobile/tablet header occupies two rows; sticky tables and drawers use the
same responsive height token.

Pages are loaded on demand with React lazy/Suspense. Login does not fetch the
private page chunks. The shell stays mounted while a destination loads, and the
existing error boundary offers recovery if a chunk fails. The leads list remains
virtualized. This change reduces the main app chunk from about 384KB to 212KB
uncompressed (113KB to 68KB gzip); shared vendor and destination chunks are
additional downloads, so these figures are not total page transfer sizes.

## Browser Check

Install the browser engines once:

```sh
npx playwright install chromium firefox webkit
```

Run from the repository root:

```sh
npm run test:ui
```

This builds the app and runs `scripts/check-ui.mjs`. Each browser receives its own
temporary API server, in-memory database, synthetic owner account, and 120 sample
leads. The check does not use personal credentials, saved leads or provider APIs.
Servers and databases are cleaned up, including on failure. Screenshot paths are
printed for manual review and remain in the OS temporary directory.

Coverage includes:

- Chromium, Firefox and WebKit navigation and JavaScript errors.
- Leads at 320, 390, 768, 1024 and 1440px viewport widths.
- Profile, Search, Settings and Applications at 320px.
- Page overflow, header overlap, sticky offsets and minimum profile target size.
- Deferred route downloads, light/dark screenshots and persisted theme selection.
- Native color scheme and browser chrome matching the selected theme.
- Keyboard skip navigation. WebKit uses Option+Tab, matching Safari's default
  macOS behavior when full keyboard link navigation is not enabled.

The static API server does not upgrade HTTP assets in development/test mode:
WebKit otherwise tries to load local JavaScript over nonexistent HTTPS. Production
retains the CSP upgrade directive and still requires HTTPS for login.

## Limits

These are automated checks against current Playwright browser engines, not a
guarantee for every browser version or physical device. Actual iOS/Android devices,
browser extensions, assistive technology and production TLS/proxy behavior need
separate deployment/device testing. The script expects a same-origin build, not a
build configured with an external `VITE_API_BASE_URL`.
