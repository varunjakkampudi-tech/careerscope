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

## 5. The V2 stack

```bash
npm --prefix v2 run typecheck
npm --prefix v2 test
docker compose -f v2/compose.yml up -d --wait   # services
```

### Windows only

Windows reserves TCP **55403-55502**, which collides with the V2 Postgres port.
A launcher at `data/windows-v2/run.mjs` remaps it and pins the Node runtime:

```powershell
node data/windows-v2/run.mjs run typecheck
node data/windows-v2/run.mjs test
node data/windows-v2/run.mjs --services up -d --wait
```

That launcher lives under gitignored `data/`, so it does **not** arrive with a
clone. On macOS and Linux you do not need it — the port collision does not
exist, and plain `npm --prefix v2` works.

## 6. VS Code

Open the folder. The workspace ships:

- `.github/agents/` — 16 specialist agents, available in the agent picker
- `.vscode/tasks.json` — **CareerScope: Engineering Control Center** and others
- `.vscode/mcp.json` — the `job-radar` MCP server

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
infra/v3/check-provenance.sh   # what is actually deployed
infra/v3/restart-stack.sh      # the ONLY supported restart
```

Never restart the proxy alone. Never deploy uncommitted code.
