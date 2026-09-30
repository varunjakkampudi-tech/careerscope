# Setup

From a fresh clone to a working environment. Written for macOS and Linux first,
with the Windows differences called out where they exist.

---

## 1. Prerequisites

| Tool             | Version   | Notes                                                            |
| ---------------- | --------- | ---------------------------------------------------------------- |
| Node.js          | **>= 24** | the repository pins 26.8.1 on Windows; any >= 24 works elsewhere |
| npm              | bundled   | workspaces and TypeScript project references are used            |
| Docker + Compose | current   | required only for the V2 stack                                   |
| git              | current   | —                                                                |

```bash
node --version && npm --version && docker --version
```

## 2. Clone and install

```bash
git clone https://github.com/varunjakkampudi-tech/careerscope.git
cd careerscope
npm ci              # root workspace (V1 + shared packages + tooling)
npm --prefix v2 ci  # V2 workspace (the deployed stack)
```

## 3. Configuration

```bash
cp .env.example .env
```

Fill it in from your own records. **Never read, print or commit a real `.env`.**

`data/` is gitignored and absent after a clone. It holds the local database,
resumes and working copies. Nothing recreates it for you — that is deliberate,
because it is private data. The application will tell you what it needs.

## 4. Verify the checkout before changing anything

Run this first so you know what was already failing:

```bash
npm run typecheck
npm run lint
npm test              # expect 1047 passed (1047), 67 files
npm run format:check
node scripts/check-agents.mjs   # expect "agent configuration valid"
```

If something here is red on a clean clone, that is a finding — record it before
you start work, so it is not later attributed to your change.

## 5. The CareerScope stack

```bash
npm run typecheck
npm test
docker compose --env-file .env -f infra/compose.canonical.yml up -d --wait   # services
```

### Windows only

Windows may reserve the default Postgres port. The local setup command pins the
workspace runtime and writes the configured service environment:

```powershell
npm run typecheck
npm test
npm run services
```

That launcher lives under gitignored `data/`, so it does **not** arrive with a
clone. The same root commands work on macOS and Linux.

## 6. VS Code

Open the folder. The workspace ships:

- `.github/agents/` — 16 specialist agents, available in the agent picker
- `.vscode/tasks.json` — **CareerScope: Engineering Control Center** and others
- `.vscode/mcp.json` — the CareerScope MCP server

**Known issue:** `.vscode/mcp.json` points into gitignored `data/` at a Windows
`node.exe` and a launcher script. After a clone on any machine — and on macOS in
particular — that MCP server will not start until the launcher is ported. This
is tracked as an open item; the agents themselves do not depend on it.

## 7. Confirm the engineering system works

```bash
node scripts/control-center.mjs
```

You should see 16 agents, the progress matrix and the current phase. If it
renders, the multi-agent system is ready. See [03-MULTI-AGENT.md](03-MULTI-AGENT.md).

## 8. Deployment — read before you push

`main` is protected by convention, not by a branch rule: **pushing to `main`
triggers the Deploy workflow, which deploys to production.**

```bash
infra/check-provenance.sh   # what is actually deployed
infra/restart-stack.sh      # the ONLY supported restart
```

Never restart the proxy alone. Never deploy uncommitted code.
