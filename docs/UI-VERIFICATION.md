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

Build the web app and start it first. `npm run test:ui` does not build or start it:

```sh
npm run build
npm run start:web          # production server on http://localhost:5280, keep it running
npm run test:ui            # in a second terminal, from the repository root
```

`test:ui` runs `scripts/tests/check-ui.ts` against disposable PostgreSQL and
Redis services (it creates and drops its own `test_<uuid>` database and starts its own API). Each browser receives a synthetic owner account and
bounded fixture data. The check does not use personal credentials, saved leads or
provider APIs. Service and browser processes are cleaned up, including on failure.

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

## Chromium acceptance run

Run on 2026-10-27 against a production build of the web app, Node 24.22.1, the project's local
PostgreSQL and Redis containers (the suite creates and drops its own `test_<uuid>` database) and
Playwright Chromium. The result is a pass for Chromium. Firefox and WebKit were not run in that pass; see the 2026-10-28 section below.

Commands, from the repository root:

```sh
npx playwright install chromium            # browsers were already present; nothing to download
npm run build                              # clean-dist, tsc -b, then the CSP wrapper (3 next builds)
npm run start:web                          # preview on http://localhost:5280
CAREERSCOPE_UI_BROWSER=chromium npm run test:ui
# focused reproduction used while diagnosing the settlement failure:
CAREERSCOPE_UI_SCENARIO=notification-panel-close-before-mutation CAREERSCOPE_UI_BROWSER=chromium   NODE_ENV=test DEPLOYMENT_ENVIRONMENT=development npm run test:ui
```

`test:ui` starts its own API on 127.0.0.1:5390, so that port must be free (a stale API from an
earlier session was holding it and was stopped). Final result: the suite printed
`chromium: search/export/cancellation, saved leads/notes/archive/conflicts, profile, logout, required
responsive-width checks passed` and `chromium: real two-account selector, session switching, keyboard,
eight-width reflow and axe passed` and exited 0. The focused scenario also passes.
`npm run test:visual` is a manual pixel-diff tool that needs a reference image per page; no
baselines are stored in the repository, so it was not run. The light and dark screenshots the
acceptance suite writes to `test-results/` are its visual output.

### Failures found and how each was resolved

Each run stopped at the first failure, so these were found one after another.

| #   | Failure                                                                                                                        | Kind                          | Cause and fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `getByRole('heading', { level: 1, name: 'Account security' })` never visible on `/settings` (three call sites)                 | Test defect                   | The page's only level 1 heading is "Settings"; "Account security" is a level 2 section heading. The axe helper waits for the level 1 heading, so the three calls now name "Settings".                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2   | `.source-options` locator never found on `/jobs`                                                                               | Test defect                   | The class moved into a CSS module, so its name is hashed. The test now selects `fieldset[aria-describedby="source-availability"]`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 3   | Expected "Resume storage capacity reached." after a 507                                                                        | Test defect                   | The resume panel shows the localized copy "Resume storage is full." The expected text was the old client message.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 4   | Settings page failed axe colour contrast in the dark theme (new check added in this pass)                                      | Product defect                | The settings panels used `--surface`, `--ink` and `--border`, which have no dark values, so they stayed white with light text. The dark shell now maps those tokens to the `--dash-*` values. The check, which toggles the dark theme on `/settings` and runs axe, now passes.                                                                                                                                                                                                                                                                                                                                                          |
| 5   | "Back to search" not disabled while "Sign out other sessions" is in flight                                                     | Product defect                | When the back button moved from the account security component into the settings page header, the guard was lost. `AccountSecurity` now reports `onBusyChange` and the page disables the button while a sign-out is pending.                                                                                                                                                                                                                                                                                                                                                                                                            |
| 6   | "notification panel close before mutation race never stopped issuing requests" (the long-standing Chromium settlement failure) | Test defect (instrumentation) | The zombie requests were reads the app had aborted when the document was replaced (the API log shows the abort 45 ms after the request). Chromium reports neither a failure nor a finish for those, so Playwright kept them in flight and the barrier waited out its 15 second deadline. Measured with the existing lifecycle probe: the request id had Playwright and CDP "started" only and the server "abort". `staleEarlierRouteRead` drops a GET fetch or script from an earlier route from the barrier. Current-route reads, writes, documents and images still count. It has a unit test in `scripts/tests/ui-requests.test.ts`. |
| 7   | Expected "No leads with status “Saved” yet. Save a job from Search to add one here." on `/saved`                               | Test defect                   | The saved scope says "jobs"; "leads" is the applications scope wording. The expected strings now match the saved scope.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 8   | Intermittent timeout on `#job-source-lever-reason`                                                                             | Product and test defect       | While the source catalog loads, each source checkbox had `aria-describedby` pointing at a reason element that is not rendered until the catalog answers (a dangling reference). The product now sets the reference only once the entry is known, and the test waits for it.                                                                                                                                                                                                                                                                                                                                                             |
| 9   | No "Mark as read" button in the notification panel after the fixture reset                                                     | Test defect                   | Earlier steps edit and complete the interview round, and the list only shows a reminder for a still-scheduled round with a matching reminder time (completing a round retires its reminder by design). The fixture now restores the round to scheduled and re-arms the reminder.                                                                                                                                                                                                                                                                                                                                                        |
| 10  | `/settings` after sign-out waited for "Account security"                                                                       | Test defect                   | Owner A has signed out, so an anonymous visit correctly shows account selection. The test now expects "Select test account" and asserts account security is not shown.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Transient: one run stopped at start-up with a PostgreSQL `statement timeout` while creating the
test database; the rerun was unaffected.

### Firefox and WebKit run (2026-10-28)

The settlement allowance `staleEarlierRouteRead` is now gated to `engine === 'chromium'`, because the
cancelled-fetch behaviour behind it was measured only in Chromium. Firefox and WebKit keep every
request in the barrier. Same setup as above (production build, `next start` on 5280, Node 24.22.1,
throwaway PostgreSQL and Redis containers), run with `CAREERSCOPE_UI_BROWSER` set to each engine:

| Engine   | Result                                                                |
| -------- | --------------------------------------------------------------------- |
| Chromium | Pass after the gating change (both result lines printed, exit 0).     |
| WebKit   | Pass with the allowance disabled (both result lines printed, exit 0). |
| Firefox  | Failed at that point; fixed, see the next section.                    |

### Settlement allowances and hosted status

Two Chromium-only allowances in `scripts/tests/ui-requests.ts` keep the request-settlement barrier from
waiting on requests the browser never reports as finished: `staleEarlierRouteRead` drops a GET fetch or
script read from an earlier route, and a second allowance drops a GET to the Next image optimiser path
`/_next/image` (the brand logo) that is cancelled when navigation starts. Every other image, write,
document and current-route read still counts, and Firefox and WebKit keep every request. The hosted run for
eec8ec4 is green. Commit 91bdb45 adds the `/_next/image` allowance; its hosted result is pending until
its run completes, and the flake rate across repeated hosted runs is not measured.

### Firefox CSP eval finding and fix (2026-10-28)

Reproduced against the production build (`npm run build`, which runs `scripts/build-with-csp.mjs`
and is the same `RUN npm run build` step the Dockerfile uses), served with `npm run start:web`. A
Playwright Firefox page listening to `console` and to `securitypolicyviolation` reported on every
page load, including `/`, `/dashboard`, `/settings` and `/jobs`:

```text
Content-Security-Policy: The page's settings blocked a JavaScript eval (script-src) ...
  (Missing 'unsafe-eval')   file: /_next/static/chunks/30bhl6h79whkg.js  line 1, column 25223
securitypolicyviolation: violatedDirective=script-src, blockedURI=eval, sourceFile=same chunk, column 25223
```

Column 25223 of that chunk is zod 4.6.7's `allowsEval` probe, `try { Function(""); return true } catch {
return false }`. zod runs it while building its first object schema, to decide whether it may
compile a faster parser with `new Function`. The throw is caught, so nothing breaks, but Firefox
logs each blocked eval as a console error. Chromium and WebKit did not fail on it in earlier runs, which is why only
Firefox failed. The other `Function(...)` strings in the bundles (core-js's `Function("return this")`
fallback and zod's `doc.compile()`) are never reached when the probe is skipped or returns false.

Fix at the source: `apps/web/src/lib/zod-config.ts` calls `z.config({ jitless: true })`, which makes
zod skip the probe and use its interpreted parser (same validation, no code generation). It is
imported first by the two browser modules that build zod schemas, `lib/api-schemas.ts` and
`components/job-search-view.tsx` (through `@careerscope/shared`). The CSP is unchanged: no
`'unsafe-eval'` was added. After the change the same probe reports no console message and no
violation on those four routes.

The check's console classifier now also matches the hyphenated "Content-Security-Policy" that
Firefox writes, so a future CSP violation is reported as `CSP violation` instead of an unclassified error.

One test change was needed for a timing race that the fix exposed. With zod's probe removed, page
timing shifted by milliseconds and WebKit (twice) and, under load, Chromium began to fail the
authenticated journey with `resource HTTP 401 at /api/searches`. That is the Jobs page's 5-second
poll landing just after the export-expiry step deletes the owner's session rows on purpose; it gets
the same real 401 as the export request. Proof it is a race and not a product regression: with the
zod change disabled, WebKit passed; with it enabled, WebKit failed twice with that single error. The
error is now in `expectedAuthenticatedJourneyConsoleErrors` with the same rationale as the existing
`/api/leads` and `/api/profile/accessibility` entries; the assertions after it (the shell reaches
account selection) are unchanged.

Final acceptance, production build, `next start` on 5280, Node 24.22.1, throwaway PostgreSQL and Redis
containers, one engine at a time with nothing else running (`CAREERSCOPE_UI_BROWSER` set per engine):

| Engine   | Result                                   |
| -------- | ---------------------------------------- |
| Firefox  | Pass: both result lines printed, exit 0. |
| Chromium | Pass: both result lines printed, exit 0. |
| WebKit   | Pass: both result lines printed, exit 0. |

### Environment limits

- All three engines pass. They were run only on the one Windows host.
- A visual regression baseline set does not exist, so pixel comparison against references was not run.
- The suite takes about seven minutes after a build and needs the Docker services in `.env`.

## Limits

These are automated checks against current Playwright browser engines, not a
guarantee for every browser version or physical device. Actual iOS/Android devices,
browser extensions, assistive technology and production TLS/proxy behavior need
separate deployment/device testing. The script expects a same-origin build, not a
build configured with an external `VITE_API_BASE_URL`.
