# Support cases for an inaccessible mailbox

Use this procedure when a candidate can no longer receive sign-in codes and has no confirmed recovery
address (V12-4.1-014). Recovery through a confirmed recovery address is handled by the candidate, not by
support (see [AUTHENTICATION](../AUTHENTICATION.md)).

## Steps

1. Ask the candidate to write to support from a channel you can verify. Do not act on a request that
   arrives only as a sign-in reply.
2. Check the candidate's identity against details that are held only on the account, such as the
   profile name and saved application history. Use only account facts that already exist and that
   support is authorized to access; the product does not retain the date of birth used for its age
   screen. If the available account facts are not sufficient, do not change the sign-in address and
   escalate for an approved recovery process. Never request a password, sign-in code, date of birth,
   or new identity document.
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
- A locked-out account's sign-in address can be changed only under an open case, with this command:

  ```bash
  npm run db:support-case -- change-email <case-id> new.address@example.test
  ```

  The change closes the case, ends every session of the account and removes any pending email change.
  The previous address then receives a notice with no code and no new address. The notice needs
  `RESEND_API_KEY` and `RESEND_FROM_EMAIL` to be set; without them the command says the notice was not sent.
  A new address that another account uses is refused, and the case stays open.
