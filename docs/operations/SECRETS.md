# Operations — secrets

Keep all real values outside Git in protected host configuration or private
volumes. Never paste values into commands, reports, screenshots or logs.

| Material                          | Consumer                              | Handling                                                                                                                             |
| --------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Database password                 | Database and API/workers              | Protected host environment; coordinate rotation                                                                                      |
| Redis password (`REDIS_PASSWORD`) | Both Redis instances, API and workers | Required in production; compose refuses to start without it; generated on the host by `deploy.sh` into `infra/.env`; never commit it |
| Resume encryption key             | API/files worker                      | Private key file and secure backup; do not regenerate over existing data                                                             |
| Session tokens                    | Browser/API                           | HttpOnly cookie; only hashes in the database; revoke server-side                                                                     |
| TLS and ACME keys                 | Caddy                                 | Persistent private certificate volume                                                                                                |
| Staging password hash             | Caddy only                            | Generate interactively; plaintext password never enters source                                                                       |
| Staging assertion                 | Caddy and API only                    | Random 32-byte hex value; operator config maps it to `TEST_PROXY_SECRET`                                                             |
| Optional provider credentials     | Required adapter only                 | Least privilege, disabled when unavailable                                                                                           |
| Resend API key                    | API process only                      | Protected runtime secret; never expose to browser, workers, Git or logs; OTP stays disabled until provider acceptance                |
| OTP HMAC secret                   | API process only                      | Dedicated random 32-byte hex key, distinct from Resend/database/session keys; rotation requires invalidating pending OTP challenges  |

The web container must not receive the database password, encryption key,
Resend API key, OTP HMAC secret, staging assertion or staging password hash. Caddy strips Authorization before
forwarding and the API redacts the private assertion header. Workers do not
receive staging credentials.

Cloud identity and cloud queue credentials are no longer required. Removing
source code does not revoke an external credential; external account changes
require the operator's separate procedure. No real credentials are rotated by
repository cleanup.

See [Private test access](../AUTHENTICATION.md),
[Privacy](../PRIVACY.md), [Backup](BACKUP.md) and [Deployment](DEPLOYMENT.md).

## Non-secret database and test tuning variables

These carry no secret. They are listed here because they sit beside connection settings in
`.env` and a wrong value changes failure behavior. Full detail is in
[`CI-CD.md`](CI-CD.md#integration-timeouts).

| Variable                        | Default (production) | Accepted               | Notes                                                                                               |
| ------------------------------- | -------------------- | ---------------------- | --------------------------------------------------------------------------------------------------- |
| `DATABASE_STATEMENT_TIMEOUT_MS` | 10000                | integer 1000 to 600000 | Pool statement timeout. With `DEPLOYMENT_ENVIRONMENT=production` a larger value is capped at 10000. |
| `DATABASE_CONNECT_TIMEOUT_MS`   | 5000                 | integer 1000 to 120000 | Pool connect timeout. With `DEPLOYMENT_ENVIRONMENT=production` a larger value is capped at 5000.    |
| `INTEGRATION_JOB_WAIT_MS`       | 10000                | integer 1000 to 600000 | Test-only: how long the BullMQ integration test waits for a job. Never set it on a host.            |

Leave all three unset in production. CI sets them only for the BullMQ suite, from
`scripts/tests/bull-queue.integration.env`.
