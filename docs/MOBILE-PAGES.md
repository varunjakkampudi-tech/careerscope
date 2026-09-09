# Mobile Job Listings On GitHub Pages

## Architecture

- The private CareerScope app, database, resume, scheduled searches and Copilot
  worker remain on the Mac. Do not upload this workspace or its data to Pages.
- The public view contains posting titles, companies, locations, sources,
  posting dates and canonical posting links. It excludes private matching data.
- Admin login opens a passphrase-encrypted, read-only snapshot with scores,
  statuses and filters. It makes no private API calls and has no server login.
  See [encrypted admin setup](ENCRYPTED-ADMIN.md) for fields and security limits.
- Android Chrome can view the site and open employer postings for manual
  applications. Phone form autofill from CareerScope is not provided. Copilot
  filling remains on the Mac. Manual applications on the phone do not sync an
  Applied status back to the private app; update it on the Mac yourself.

## Visibility

Standard GitHub Pages is public, not access-controlled by possession of a link.
Anyone can redistribute the URL or download the job list. The public view permits
indexing; the admin HTML uses `noindex`. Neither robots rules nor `noindex`
enforce privacy. The encrypted snapshot requires a strong passphrase. The list
itself can reveal job-search interests. Do not publish unless this is acceptable.
Deleting a published snapshot cannot remove copies others already downloaded.

## Generate Locally

```sh
npm run mobile:test
npm run mobile:export
```

The exporter opens the existing SQLite database read-only and writes the public
snapshot to `mobile-site/jobs.json`. It uses a strict field allowlist and exports only supported
public portal URLs. Tracking query parameters and fragments are removed; only
known job-ID parameters are retained. Unsupported hosts are omitted rather than
risk publishing email tracking or application-session links. Opening a posting
may still require employer sign-in and may reveal that it is already closed.
Personal notes about closures are never included in this public export.

To regenerate the local snapshot when leads change, keep this running on the Mac:

```sh
npm run mobile:watch
```

It checks once a minute, writes the JSON atomically and does not change the
snapshot timestamp if the public jobs have not changed. This watcher exports
locally only. It does not upload files or possess GitHub credentials.

## GitHub Publication

Repository: <https://github.com/varunjakkampudi-tech/careerscope>

Public site: <https://varunjakkampudi-tech.github.io/careerscope/>

Pages uses **GitHub Actions**. Generate both snapshots with `mobile:export` and
`mobile:admin`, validate with `pages:test`, then commit the reviewed site files
and snapshots and push to `main`. Export commands do not commit or push.

The workflow runs security checks and `scripts/stage-pages.mjs`, which validates
the public fields and encrypted envelope before copying an explicit asset
allowlist. A missing encrypted snapshot stops deployment. The source repository
is public, but `.env`, databases, resumes and browser state must never be committed
or placed in the Pages artifact. GitHub Actions cannot read the private Mac DB.

## Daily Updates

Settings now supports a start time and IANA timezone. The selected schedule is
07:00 Asia/Kolkata. The API must remain awake and running; after waking late it
can make one attempt for that local date. A prior scheduled attempt on the same
date suppresses another attempt, including one made before changing the schedule.
Use Search for an immediate manual refresh when necessary.

The scheduler reuses saved sources, threshold and posting window. Unavailable
sources pause an attempt. Browser-based manual Gmail collection is separate;
unattended Gmail still requires OAuth configuration. Results and completion
times depend on providers. No phone/email delivery notification is implemented.

The last deployed site remains available while
the Mac sleeps, but fresh jobs cannot be collected/exported/uploaded until it
is awake and the required processes run. GitHub deployment can take a few
minutes. The mobile page displays the export timestamp and refreshes its data
when reopened or when its Refresh button is used.
