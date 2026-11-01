# Support cases for an inaccessible mailbox

Use this procedure when a candidate can no longer receive sign-in codes and has no confirmed recovery
address (V12-4.1-014). Recovery through a confirmed recovery address is handled by the candidate, not by
support (see [AUTHENTICATION](../AUTHENTICATION.md)).

## Steps

1. Ask the candidate to write to support from a channel you can verify. Do not act on a request that
   arrives only as a sign-in reply.
2. Check the candidate's identity against details that are held only on the account, such as the
   profile name, date of birth, and the most recent application. Never ask for a password or a sign-in
   code, because none is needed here.
3. If the check passes, open a case with a reason of at least 10 characters:

   ```bash
   npm run db:support-case -- open candidate@example.test "Mailbox lost; identity checked by profile details"
   ```

   The command prints the case id and the expiry. A case expires 24 hours after it is opened.

4. Close the case as soon as the check ends, whether it passed or failed:

   ```bash
   npm run db:support-case -- close <case-id>
   ```

## What a case does and does not do

- A case records the operator, the reason, and the time window. It is stored in `support_cases`.
- A case does not sign anyone in and does not change the sign-in address. It is the time-limited record
  that an identity check was made.
- The case is not yet required by the email-change route. Until that is built, an operator must check
  the case table before any manual change to a sign-in address.
