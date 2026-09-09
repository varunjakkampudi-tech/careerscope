# Static Pages Release Review

Reviewed 2026-09-09. Scope: public listings and encrypted admin snapshots on
GitHub Pages, not a certification of the entire private Mac application.

## Decision

Approved for local acceptance testing. Production publication is pending a real
encrypted export, owner unlock verification, deployment, and a physical-phone
check. No real passphrase or `admin.enc.json` was present during this review.
No software was installed and no inbound network access was opened on the Mac.

This is a read-only snapshot product. It is not a server login, editable cloud
profile, live database connection, or mobile Copilot worker. Dummy credentials
are used only with synthetic test fixtures and never protect real lead data.

## Engineering Assessment

These are subjective review scores, not measured compliance percentages.

| Area                     | Score  | Assessment                                                                                                                                                                                            |
| ------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI and responsive design | 9/10   | Shared light/dark/system themes, stable controls, compact mobile filters, consistent spacing and typography.                                                                                          |
| Snapshot features        | 8/10   | Public browsing, private scores/status/source filters, sorting and manual posting links. No bidirectional sync or profile editing by design.                                                          |
| Architecture and privacy | 8.5/10 | Local processing, explicit field allowlists, authenticated encryption, no decrypted browser persistence, guarded deployment artifact. Offline password guessing and compromised hosting remain risks. |
| Accessibility            | 7.5/10 | Keyboard, labels, landmarks, focus, empty/error states and measurable contrast checked. Not WCAG-certified; manual assistive-technology testing remains.                                              |
| SEO                      | 7.5/10 | Public title/description/canonical/Open Graph/sitemap; admin noindex. Search-engine rendering/indexing and ranking are unverified.                                                                    |
| Test coverage            | 8.5/10 | Three-engine screenshot matrix and behavioral/security tests. Local initial baselines, not historical production baselines.                                                                           |
| Production operations    | 6/10   | Export and staging commands ready; real secret, encrypted data, deployment and phone acceptance still pending.                                                                                        |

Overall provisional assessment: **8/10**. A 100% readiness or security guarantee
would be unsupported. All concrete code issues found in this scoped review were
addressed; remaining acceptance and tooling limits are listed below.

## Verified

- `npm test`: 956 tests passed across 57 files.
- `npm run pages:test`: 7 checks passed for encryption, wrong-password/tamper
  rejection, field allowlists, staging guards, env configuration, and themes.
- `node scripts/check-admin-ui.mjs`: unlock, safe text/URL rendering, source and
  score/status filtering, pagination, locking, five-minute inactivity lock,
  no decrypted persistent storage, and desktop/mobile checks passed.
- `npm run pages:visual:update` followed by `npm run pages:visual`: 120 exact
  screenshot matches in an independent run. Chromium, Firefox and WebKit;
  widths 320, 390, 768, 1024, 1440 and 1920; light and dark; public, locked and
  unlocked admin states; additional empty/error states at mobile width.
- Browser checks cover shared theme persistence, system-color changes,
  keyboard skip links, unique IDs, control names, landmarks, image loading,
  horizontal overflow, external-link protections, no sessionStorage, and
  theme-only localStorage. Representative screenshots were visually reviewed.
- Staged synthetic assets were served beneath `/careerscope/` to exercise
  project-relative paths. Public refresh retains the last snapshot on network
  failure and skips malformed or unsafe URLs.
- Repository lint passed with zero errors and three pre-existing console warnings;
  full TypeScript checks and the production build passed. The private React application was not replaced
  by the static site; previous unrelated worktree edits were preserved.

## Issues Addressed

- Replaced hard-coded colors with a shared theme palette and native color-scheme.
- Added consistent System/Light/Dark selection and theme-color metadata.
- Corrected a slider label that was associated with its output rather than input.
- Fixed undersized WebKit select controls with explicit dimensions and a Lucide icon.
- Improved placeholder and slider contrast, mobile filter access, skip navigation,
  unlock focus, busy/error states, empty results and safe-area spacing.
- Avoided WebKit viewport-edge row pop-in by rendering the first 50 rows normally.
- Added public SEO metadata without exposing admin content to indexing.
- Added local-only env configuration and rejection of known dummy passphrases.
- Added an explicit staging allowlist and required valid encrypted envelope;
  unexpected public fields or plaintext admin JSON stop deployment.

## Limits And Acceptance Gates

- No axe/Lighthouse audit engine was installed for this work. Automated semantic
  and contrast checks are targeted checks, not full WCAG conformance testing.
- WebKit sometimes exposes empty inherited CSS variables/default text colors
  for rendered body/select nodes after navigation. Those contrast samples are
  reported as inconclusive, not passed. Rendered screenshots were inspected.
- WebKit blocks Playwright's screenshot-only inline stylesheet injection under
  the strict CSP. Only that warning during capture is recorded as a tooling
  limitation; other application console errors still fail. Production CSP was
  not relaxed for the test runner.
- Baselines are local, ignored files under `test-results/pages-baseline`.
  Results and limitations are in `test-results/pages/summary.json`. On a fresh
  machine, create and review initial baselines explicitly; do not automatically
  update them in regression runs. Browser/OS changes can alter rendering.
- Test fixtures contain synthetic leads and a synthetic passphrase. Real-user
  decryption on mobile, actual employer application forms, screen readers,
  password managers, text zoom, and physical iOS/Android devices are not certified.
- Project-path robots.txt may not be read because crawlers normally request
  the origin-root robots.txt. The admin HTML independently carries noindex.
  Public listings depend on JavaScript; no expired-job structured data is emitted.
- Public-hosted ciphertext allows offline guessing; use a strong unique secret.
  Old Git history/downloads cannot be revoked by changing the next passphrase.
- Updates require local export and a push. There is no automatic uploader or
  reverse status synchronization. The Mac can be off when reading the snapshot.

## Release Steps

Publication preparation follow-up: a strong random passphrase was generated
locally with explicit owner approval, 1,950 leads were exported as ciphertext,
and the real snapshot successfully unlocked and locked in a mobile-sized local
browser. The artifact passed staging validation. No passphrase or private lead
records were printed. This resolves the initial local-export prerequisite; live
deployment and physical-phone acceptance are separate checks.

1. Set `ADMIN_SNAPSHOT_PASSPHRASE` privately in the ignored root `.env`, or leave
   it empty and use hidden terminal input. Never use a `VITE_` secret. See
   `docs/ENCRYPTED-ADMIN.md`; the example variable is in `.env.example`.
2. Run `npm run mobile:admin` and unlock the result in
   `npm run pages:preview` at `http://127.0.0.1:5176/admin.html`.
3. Run `npm run pages:test`, then `npm run pages:stage` with no pre-existing
   `_site` directory. Verify that only allowlisted files are staged.
4. Commit only the reviewed Pages implementation and encrypted snapshot, not
   `.env`, private DB/resumes, test artifacts, or unrelated worktree changes.
5. Push, confirm the Pages workflow succeeds, and verify public browsing and
   private unlocking at the HTTPS site on your phone before release approval.
