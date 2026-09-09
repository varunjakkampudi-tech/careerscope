# Gmail Job Alerts

Gmail is an optional, read-only job source. It uses the Gmail API to read recent
LinkedIn, Naukri, and Indeed alerts from your own account. It does not send email,
mark messages read, delete mail, or download attachments and tracking images.

## Connect Your Account

1. In Google Cloud Console, create or select a project and enable the Gmail API.
2. Configure the OAuth consent screen. For a personal app in testing, add your
   Google account as a test user. Request only
   `https://www.googleapis.com/auth/gmail.readonly`.
3. Create a Web application OAuth client. Add
   `https://developers.google.com/oauthplayground` as an authorized redirect URI.
4. Open Google's OAuth 2.0 Playground. In its settings, enable **Use your own
   OAuth credentials** and enter your client ID and secret there. Select offline
   access, authorize the Gmail read-only scope, then exchange the authorization
   code for tokens.
5. Enter these values directly into the API host's `.env` file:

   ```dotenv
   GMAIL_CLIENT_ID=your-client-id
   GMAIL_CLIENT_SECRET=your-client-secret
   GMAIL_REFRESH_TOKEN=your-refresh-token
   ```

6. Restart the API. In Search, select **Gmail job alerts**. Settings also reports
   whether the credentials are configured. This status is not a live OAuth check;
   an expired or revoked token is reported in the search run.

Do not put credentials in profile JSON, browser storage, screenshots, or chat.
The server refreshes short-lived access tokens automatically. Google OAuth apps
in external Testing status commonly receive refresh tokens that expire after
seven days; reauthorize or configure the appropriate publishing status. Google's
verification requirements may apply when distributing the app to other users.
Revoke access from your Google account's third-party connections to disconnect.

## Supported Alerts And Limits

- The search is restricted to messages from `linkedin.com`, `naukri.com`,
  `indeed.com`, and `indeedmail.com`, including subdomains. Trash, spam, sent mail,
  and drafts are excluded. Sender matching is a filter, not proof of authenticity.
- Multipart HTML alerts are supported. Each job must have a recognizable direct
  portal link, readable role title, and company name. Multiple jobs are separated
  by their surrounding HTML blocks; unfamiliar templates can be skipped.
- Supported links are LinkedIn `/jobs/view/...`, Naukri `/job-listings-...`, and
  Indeed job links carrying `jk`. Opaque tracking redirects and plain-text-only
  alerts are not currently supported. The provider never follows email links.
- Up to 200 messages are scanned per run, within the chosen search window.
  Duplicates with the same portal job ID are suppressed during ingestion.
- Only extracted job-card text and job links enter the normal lead pipeline.
  Whole mailbox messages, OAuth tokens, and attachments are not stored in SQLite.
- The email's arrival date controls which alerts are read. It is **not** presented
  as the job posting date. Missing location, salary, and posting date remain unknown.
- Alerts are snippets, not verified full job descriptions, so their scores are
  capped at **80%**. At the default **85%** filter they are not visible. Lower the
  results filter to inspect them; use full-description ATS/API sources for stronger
  matches. Gmail cannot guarantee complete or still-open postings on every portal.

## Automatic Searches

Use **Settings > Automatic search > Every day** for a daily search, or **Off**
to disable it. This persisted choice takes precedence over the environment variable
and applies without restarting. See [PROFILE-WORKFLOW.md](PROFILE-WORKFLOW.md).

Before a UI choice is saved, `SEARCH_INTERVAL_MINUTES=360` means every six hours
while the API is running, or `0` means disabled. The environment minimum is six
hours to respect feed rate limits.
The scheduler checks once per minute and remembers its last attempt across restarts.

Save a profile first. Run a manual search with the sources, date window, and
threshold you want; future automatic searches reuse those settings. Before the
first manual search, the defaults are all configured sources, 30 days, and 85%.
An active search prevents overlap. Missing selected credentials or disabled
reranking pause the scheduled attempt and produce a server log warning.

The browser can be closed, but the API host must stay running and awake. There is
no backfill of every missed interval after downtime. Searches remain bounded by
source limits and configured result caps; no provider can promise every latest job.
