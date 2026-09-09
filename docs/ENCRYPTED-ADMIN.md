# Encrypted Admin Snapshot

The existing public Pages jobs list remains public. Its Admin login link opens
`admin.html`, a passphrase-unlocked, read-only snapshot of the Mac's matching
results. This is not a server account or the local owner's login password.

## Export On The Mac

Run `npm run mobile:admin` in your own terminal. Choose a unique passphrase of
at least 12 characters, preferably several randomly selected words generated
by a password manager. Input is hidden. Do not enter it in chat, command-line
arguments, or GitHub secrets. Keep it in your password
manager; there is no password recovery for an existing snapshot.

Alternatively, set `ADMIN_SNAPSHOT_PASSPHRASE` in the existing ignored root `.env`
on your Mac, then run `npm run mobile:admin`. Leave it empty to use hidden input.
Never use a `VITE_` prefix: frontend environment variables are public. Protect
the local `.env` with owner-only permissions. Known placeholder values and short
passwords are rejected, but length checks cannot guarantee password strength.
No dummy credential unlocks real leads; synthetic credentials exist only in tests.

For initial setup, `node scripts/setup-admin-secret.mjs` can generate a strong
random passphrase in an existing local `.env` without printing it. The helper
restricts that file to owner-only permissions and refuses to replace a configured
passphrase. Retrieve the generated value privately from your local `.env` when
unlocking on your phone; never send it to chat or publish it.

The command reads SQLite without modifying it and writes only encrypted data to
`mobile-site/admin.enc.json`. Plaintext export files are never created. All leads
for the single owner profile are included with title, company, location, source,
posted date, sanitized posting link, match score, and status. Unsafe links become
null; their leads are retained. Profile metadata is limited to its update time
and whether a resume is attached. No resumes, contact details, notes, credentials,
or browser state are included.

Commit the encrypted file and the admin site assets, then push to the existing
repository. The Pages workflow publishes only explicitly listed site assets
and the encrypted snapshot. Deployment now requires a valid encrypted envelope
and rejects unexpected fields in either export. The passphrase never goes to GitHub.
Re-export and publish when you want fresh results. Exporting does not push or
schedule publication automatically.

## Change The Passphrase And Publish

Update `ADMIN_SNAPSHOT_PASSPHRASE` in the ignored root `.env`, then run:

```sh
npm run pages:publish
```

This command reads the current `.env` on every run, overriding any stale shell
value, re-encrypts the admin snapshot, increments the patch version, and commits
the ciphertext with the root package/lockfile and generated app/Pages version
files. It then pushes `main` to `origin`. Commit intended code changes first and
leave no staged changes or uncommitted version files. Uncommitted code changes
are not included. A missing or invalid passphrase or a failed export stops
publication. If a later step fails, release files or a commit may remain locally.
If the push alone failed, resolve Git access and push the existing commit rather
than running another version bump.

Choose a release type explicitly when needed:

```sh
npm run pages:publish -- patch
npm run pages:publish -- minor
npm run pages:publish -- major
```

- Patch: fixes and snapshot refreshes, for example `1.0.0` to `1.0.1`.
- Minor: backward-compatible features, for example `1.0.1` to `1.1.0`.
- Major: breaking changes, for example `1.1.0` to `2.0.0`.

The root `package.json` is the product release source; internal workspace package
versions are independent. `npm run version:sync` regenerates the local app and
public/admin footer versions. CI runs `version:check` to reject inconsistent
version files. Version increments happen before publication, not in CI: rerunning
the same commit uses the same version. Direct pushes do not infer a release type;
use `pages:publish` for versioned releases. Do not change encryption envelope or
snapshot schema versions for a product release.

After the Pages deployment succeeds, reload the admin page and unlock with the
new value. The password never goes to GitHub. An ordinary `git push` or workflow
rerun cannot read your local `.env` and will not automatically rotate the
snapshot: use `pages:publish` for future releases. This command updates the admin
snapshot only; use `mobile:export` and commit its output to refresh public jobs.
Changing the password does not revoke older downloaded snapshots or already
unlocked browser sessions. This does not change the local workspace login.

## Mobile Use

Open the Pages site, select Admin login, and enter the snapshot passphrase.
Search, select multiple sources, filter scores/status, sort, and open employer
links for manual applications. The private list is decrypted in browser memory,
not saved to localStorage, sessionStorage, or IndexedDB. To survive refresh, the
current tab stores a snapshot-bound decryption key and last-activity time in
sessionStorage. The passphrase is never stored. The key is sensitive: anyone with
access to the open tab or its storage can decrypt that snapshot. Lock removes the
key and rendered data; five minutes of inactivity expires the session. Refresh
restores only an unexpired key for the same encrypted snapshot. A newly published
snapshot requires unlocking again. Storage-blocked browsers fall back to
memory-only unlocking and require the passphrase after refresh.

Normal tab closure ends tab storage, but browser session restore or tab duplication
may retain/copy it. Use Lock before leaving a shared device. Navigating to public
jobs keeps the unexpired tab session. JavaScript cannot guarantee immediate memory
erasure by the browser or prevent OS screenshots/tab previews. Use a trusted device.

Both pages share a System/Light/Dark selector. Only the theme preference is stored
in localStorage; decrypted data and the passphrase are not. Public metadata opts
into indexing; admin stays noindex. On project Pages, the origin-root robots.txt
belongs to the account site, so project-path robots.txt is advisory and may not
be discovered by crawlers. The admin HTML noindex tag is still applicable.

The snapshot does not edit your profile, upload resumes, run searches/Copilot,
or synchronize application statuses back to the Mac. Full profile editing stays
in the local app. The laptop can be off while you browse the published snapshot.

Admin navigation includes Leads, Search (exported jobs), and Applications (exported
applied/interviewing/rejected statuses). Appearance and Lock remain in the header;
the Settings and Profile navigation icons have been removed. No additional private
profile fields are published. Public jobs, the
unlock screen, and all admin views share the same theme and responsive shell.

## Security Boundaries

Encryption uses Web Crypto AES-256-GCM with a random 96-bit nonce and a random
128-bit salt for each export. PBKDF2-SHA256 derives the key with 600,000 iterations.
Decryption rejects unsupported settings, wrong passwords, and modified ciphertext.

The encrypted file is publicly downloadable and supports offline password
guessing. A strong unique passphrase is essential. File size and publication
timing remain visible. Git history can retain older encrypted snapshots; changing
the passphrase does not revoke old copies. Anyone able to modify the hosted
JavaScript can capture a future unlock passphrase, so protect the GitHub account
and only unlock on your expected HTTPS site. No software installation or incoming
network access to the office laptop is needed, but employer data policies still
apply to anything published.

Validate with `npm run mobile:admin:test` and `node scripts/check-admin-ui.mjs`.
Browser tests use synthetic data and an already-installed Playwright browser.
