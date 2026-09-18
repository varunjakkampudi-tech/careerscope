# Restoring a session on a new machine

**Read this first: git cannot carry your chat history, and it never will.**

Copilot chat lives in VS Code's `workspaceStorage`, in a folder named for a hash
of the **workspace path**. `/Users/you/careerscope` and `C:\Users\you\careerscope`
hash differently, so a clone on a new machine gets a new, empty folder.

What _does_ transfer is everything that matters: `.ai/`, `review.txt`,
`.github/agents/`, the control center and this folder are all in git. Clone and
the entire engineering system works, with full history and context. **The chat
is a convenience; the durable records are the handoff.**

---

## Take a backup

```bash
node scripts/backup-session.mjs          # full
node scripts/backup-session.mjs --slim   # skip ~29 MB of edit snapshots
```

Writes to `data/session-backups/<timestamp>/`, which is **gitignored and must
stay that way** — a transcript contains whatever was discussed, including
infrastructure detail. This repository is public.

It captures `chatSessions/`, `GitHub.copilot-chat/` (the transcripts),
`chatEditingSessions/`, `state.vscdb` and `workspace.json`, plus a
`MANIFEST.json` recording the platform, git HEAD and restore steps.

### Run it twice

VS Code does not necessarily write `chatSessions/` until the window closes. A
backup taken mid-session can hold the transcript without holding a session VS
Code can reopen — the tool warns when it sees this.

**Close VS Code, reopen it, then run the backup again.** That copy is the one
most likely to restore.

## Move it across

It is roughly 140 MB full, or 110 MB slim. Use anything except git:

USB drive · AirDrop · iCloud / OneDrive / Drive · `scp` between the machines.

**Do not commit it.** This repository is public, and deleting a file in a later
commit does not remove it from git history — it stays in the pack files, clonable
and indexed, permanently. Purging it would require rewriting every commit hash,
which would break the deployment provenance chain.

## Restore

The storage hash **will** differ on the new machine. Do not copy into the old one.

1. Clone the repository and open the folder in VS Code once.
2. **Close VS Code completely.**
3. Find the new storage folder — the one under `workspaceStorage` whose
   `workspace.json` `"folder"` matches the new path:

   ```bash
   # macOS
   grep -l "careerscope" ~/Library/Application\ Support/Code/User/workspaceStorage/*/workspace.json
   ```

4. Copy `chatSessions/` and `GitHub.copilot-chat/` from the backup into it.
5. Reopen VS Code.

`state.vscdb` is included for reference, but overwriting it replaces **all**
workspace UI state, not just the chat. Prefer the two folders above.

## If the restore does not work

It may not — VS Code's chat storage format is not a supported interchange
format, and this is best-effort. Fall back to the durable records, which are
designed for exactly this:

```bash
cat START-HERE/README.md          # orientation
cat .ai/CAREERSCOPE-PROGRESS.md   # what is done, with evidence
tail -200 review.txt              # what recent cycles actually did
cat .ai/AGENT-SETUP.md            # how the agent system is configured
node scripts/control-center.mjs   # current state
```

The transcripts in `GitHub.copilot-chat/transcripts/*.jsonl` remain readable as
plain JSONL even when VS Code will not reopen them, so the conversation is never
actually lost — only its UI.
