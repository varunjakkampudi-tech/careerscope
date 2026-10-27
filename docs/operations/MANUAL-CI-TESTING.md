# Manual GitHub Actions testing

This procedure becomes usable only after the owner enables GitHub Actions and
the first workflow run verifies the YAML and hosted-runner behavior. As of
2026-10-20 Actions is disabled, so these steps are instructions, not evidence of
a run.

1. Open the CareerScope repository on GitHub and choose **Actions**.
2. Select **CareerScope CI**, then **Run workflow**.
3. Choose one allowlisted suite: `all`, `checks`, `integration`, `browser`,
   `cross-browser`, `domain`, `security`, `performance`, `soak`, or `recovery`.
4. Choose `chromium`, `firefox`, `webkit`, or `all` for a selected browser suite.
   A scheduled nightly run always selects all three engines.
5. Run only against the workflow's isolated, loopback-bound ephemeral
   PostgreSQL and Redis containers (queue Redis uses AOF and `noeviction`).
   Staging and production are not selectable.
6. Inspect every job and step. A skipped required suite is incomplete, and a
   run with an audit finding is not green. Record the exact workflow URL, run
   number, SHA, trigger, test results, and any sanitized findings in the pull request or release notes.

No secrets are required by these test workflows. Do not add provider credentials,
production values, test-account passwords, private resumes, or personal data to
workflow inputs or artifacts. Browser screenshots are intentionally not uploaded
until their contents receive a privacy review.

Local equivalents and environment setup are documented in
[`../TESTING.md`](../TESTING.md) and [`CI-CD.md`](CI-CD.md).
