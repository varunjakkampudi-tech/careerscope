# Blockers

Each blocker names what cannot be finished here, who must act, and which stage it affects. Nothing in
this file is a claim that an item passed.

| ID   | Blocker                                    | Affects    | Owner action                                                                                                     |
| ---- | ------------------------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------- |
| B-03 | Enabling new-user registration (item 2.09) | Deployment | The owners approve the legal text and its public HTTPS URLs; then set `REGISTRATION_ENABLED=true` at deploy time |

Resolved in stage 02: the Resend domain (item 2.20) is Verified in the dashboard, and a live notice
reached Delivered status. The owner checked the notice in Gmail: it sits in the inbox, not the spam
folder. The lost-email recovery policy (item 2.17) was decided and built. B-02 (second email provider)
was decided by the owners: not in stage 02. The decisions are in [GAP-MATRIX](GAP-MATRIX.md).
