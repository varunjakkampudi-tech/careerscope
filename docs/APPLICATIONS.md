# Copilot Application Agent

## Setup

This is an opt-in local desktop workflow with review-first and per-job automatic
submission modes, not a universal unattended
ATS integration. It launches a separate Copilot CLI session through the SDK; it
does not send a prompt to an existing VS Code chat.

1. Install GitHub Copilot CLI and sign in with an account entitled to Copilot.
   On this Mac the installed executable is `~/.local/bin/copilot`.
   Run `~/.local/bin/copilot login --web-flow` yourself and complete GitHub authentication,
   then select **Refresh agent status** in Job Radar. Use the API's configured
   executable, which may differ from the `copilot` wrapper on your shell path.
   The SDK uses CLI mode to access the OS credential store; empty mode disables
   Keychain access. Session tools and ambient features remain explicitly restricted.
   Never paste tokens, passwords or verification codes into Job Radar.
2. Run `npx playwright install chromium` from the repository root.
3. Set `ENABLE_APPLICATION_AGENT=true` in the local API environment. Set
   `APPLICATION_COPILOT_PATH` when the CLI is not at `~/.local/bin/copilot`.
   Restart the API after changing environment variables. Use a loopback binding
   such as `HOST=127.0.0.1`; do not expose this development instance publicly.
4. Keep the desktop session and API running. A graphical display is required.
   Automation controls reject non-loopback clients and production mode.
   The [mobile job-list export](MOBILE-PAGES.md) is read-only and cannot control Copilot.

## Workflow

Open a lead and review the data-sharing consent. Optionally select **Authorize
automatic submission for this job**, then choose **Apply with Copilot** once to
start. Automatic submission is off by default and resets for another job.
A saved profile and attached resume are required.
The worker opens the posting, is instructed to find and verify the exact employer
job, fills known fields and uploads the attached resume. Unknown answers are
questions, not guesses. Account creation, terms, consent and checkbox/radio choices
need approval in both modes. Passwords, sign-in, OTP and CAPTCHA require direct
browser input. Automatic mode permits ordinary navigation and final submission
for this job under the initial authorization; uncertain actions still pause.

**Applications** shows persisted progress across navigation and page refreshes.
Only one application can run at a time. Questions and approvals have single-use
IDs; stale replies are rejected. In review-first mode, every click needs approval
and final submission has a distinct review state and
**Approve submission** control. Read both the summary and actual employer form
before approving. The agent is fallible; its summary is not an independent audit.
Automatic mode records the authorization and submission events without another
final approval click. New employer confirmation refreshes the lead list's status.
Progress and questions appear in the app; email/push delivery is not implemented.

A lead is marked Applied only after an approved final click and a new visible
application-specific confirmation. Confirmation is heuristic, not an employer API
receipt. Verify the employer portal when in doubt. A click alone is not success.
Cancellation during submission, disconnects and restarts can leave the outcome
unknown. The app does not automatically retry. Check the portal before starting
another attempt, especially if there is an uncertain outcome.
The app blocks retries of an uncertain attempt until you acknowledge that you
checked the employer portal and confirmed it was not received. This acknowledgment
is tied to the specific attempt and stored with the retry; an old acknowledgment
cannot authorize a later uncertain attempt. Legacy failed records without outcome
metadata conservatively require this check. A confirmed submission cannot be retried.

## Daily Leads

Set **Settings > Automatic search** to **Every day**. The saved source selection,
score threshold and posting-date window are reused, and results are matched to
the saved profile. The API must stay running and the machine awake. The interval
is 24 hours unless a daily start time and IANA timezone are saved in Settings.
A timed schedule runs once per local date after that time, including one catch-up
when the Mac wakes later that day; it is not a guaranteed completion time. Unavailable selected
sources or invalid saved settings can pause a scheduled attempt; review Search
and its source results. No service covers every job or every portal.
Settings displays the last recorded scheduling result and refreshes it every
minute while open. A queued status only confirms enqueueing, not successful
provider collection. The diagnostics cover attempts recorded after this update;
they do not backfill older runs or indicate that a sleeping API is healthy.

## Privacy And Limits

- Starting shares the saved profile, extracted resume and job with Copilot. Page
  text and tool interactions also reach the model. Copilot plan usage may apply.
- Form entry and resume upload can transmit data before final submission, for
  example through employer autosave. Consent covers that preparation too.
- The dedicated browser profile is under `DATA_DIR/application-agent/browser`.
  Cookies and employer sign-ins may persist there. It never attaches to existing
  personal browser tabs. Log out in that browser when appropriate; stop the API
  before removing its browser profile to clear local sign-ins.
- Copilot uses the signed-in user's `~/.copilot` runtime directory. Session memory
  and session-store indexing are disabled, but runtime session files may still
  persist prompts and tool data. Treat that directory and data backups as private.
- Progress/questions/confirmation are stored in SQLite, bounded to 200 events
  per application. Field values are not included in routine progress events.
  Never place secrets in question replies; replies are sent to Copilot.
- The SDK exposes only the six application tools, with no shell, arbitrary script,
  filesystem browsing, built-in coding tools or external MCP tools.
- Browser checks block common local/private destinations and require HTTPS.
  These checks are defense in depth, not an OS-level network sandbox. Do not run
  this worker on a host with privileged network access or expose it as a public service.
- Custom widgets, cross-origin form APIs, anti-bot checks, non-English confirmation
  pages and portals that prohibit automation may need manual completion. No
  CAPTCHA bypass, invented answers, fees or guaranteed portal coverage.
- Sessions have a 30-minute model-turn timeout and a 150-step budget. A restart
  ends the browser session; progress is retained, but the session cannot resume.

## Verification

Worker tests use a fake Copilot runtime and synthetic candidate. The Chromium
integration test uses a network-isolated fixture form, covering field fill,
resume upload, secret refusal and changed-control rejection. It skips when
Chromium is not installed. No real application is submitted by the tests.
Worker tests cover automatic submission authorization, manual-review defaults,
sensitive-action pauses and confirmation-only Applied updates. An authenticated
live Copilot/employer run still requires user sign-in and has not been verified.
