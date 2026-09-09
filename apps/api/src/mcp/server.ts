/**
 * The MCP tool surface.
 *
 * This repo began as a stdio MCP server for VS Code Copilot, and that entry
 * point is kept — but as a *second face on the same services*, not a second
 * implementation. Every tool below reads and writes through the same
 * {@link Container} the HTTP API uses: the same database file, the same
 * repositories, the same scoring engine, the same queue. Ask Copilot to search
 * and the leads show up in the web UI; mark one applied in the UI and Copilot
 * sees it. That shared brain is the whole reason this file exists rather than
 * the original `src/server.ts`.
 *
 * ## What changed from the original tool set
 *
 * The old server had sixteen tools, ten of which drove a headful Playwright
 * browser: `login_indeed`, `login_linkedin`, `start_applying`, and so on. Those
 * are gone from here, deliberately:
 *
 *  - **The login tools were a step, not a capability.** They existed to get a
 *    scraper past a sign-in wall. The keyless ATS and aggregator providers need
 *    no session at all, so there is nothing to log in to.
 *  - **Auto-apply needs a human in the loop** — a visible browser, someone to
 *    clear a CAPTCHA, someone to approve a final submit. That does not survive
 *    the move to a server process, and pretending otherwise would produce a tool
 *    that hangs forever waiting for a click nobody is there to make.
 *
 * ## Long runs over a synchronous protocol
 *
 * MCP is request/response; a search run takes minutes. `search_jobs` therefore
 * *enqueues* and returns a run id immediately, and the caller polls
 * `run_status`. `wait` is offered as a convenience for an assistant that would
 * rather block, but it is bounded and returns the partial state on timeout
 * rather than failing — a run still going after the wait expires is normal, not
 * an error.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { parseResume } from '@job-radar/resume';
import { describeProviders } from '@job-radar/providers';
import {
  leadQuerySchema,
  leadUpdateSchema,
  profileSchema,
  profileUpdateSchema,
  searchRequestSchema,
  type Lead,
  type SourceId,
} from '@job-radar/shared';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { z } from 'zod';
import type { Container } from '../container.js';
import { toCapabilities, toSourceInfo } from '../routes/sources.js';
import { exportLeadsCsv, exportLeadsXlsx } from '../services/exporter.js';
import { now } from '../util/time.js';

/** Bounded so a blocking client cannot wait on a stuck run forever. */
const MAX_WAIT_MS = 120_000;
const POLL_INTERVAL_MS = 1_000;

/** Matches the HTTP export cap, for the same memory reason. */
const MAX_EXPORT_ROWS = 5_000;

export function buildMcpServer(container: Container): McpServer {
  const { repos, queue, providers, env, logger } = container;

  const server = new McpServer({ name: 'job-radar', version: '1.0.0' });

  /* ---------------------------------------------------------------------- */
  /* Profile                                                                */
  /* ---------------------------------------------------------------------- */

  server.registerTool(
    'get_profile',
    {
      title: 'Get the candidate profile',
      description:
        'Return the saved profile: contact details, preferences (target titles, tech stack, ' +
        'locations, employment types, exclusions) and application details (current/expected CTC, ' +
        'notice period, years of experience, relocation). Returns null when none is configured.',
      inputSchema: {},
    },
    async () => {
      const profile = repos.profiles.get();
      if (!profile) {
        return json({
          profile: null,
          message: 'No profile yet. Use set_profile, or upload a resume in the web UI.',
        });
      }
      return json({ profile });
    },
  );

  server.registerTool(
    'set_profile',
    {
      title: 'Create or update the candidate profile',
      description:
        'Deep-merges a partial profile into the saved one, creating it if absent. Only the fields ' +
        'you pass are changed. CTC fields are free text ("45 LPA", "₹45,00,000") — they are shown ' +
        'to you, not parsed into a number, so write them the way you would say them.',
      inputSchema: {
        profile: z
          .record(z.unknown())
          .describe('Partial profile: { candidate?, preferences?, application? }'),
      },
    },
    async ({ profile }) => {
      const at = now();
      const existing = repos.profiles.get();

      if (!existing) {
        // A create has to satisfy the full schema — there is nothing to merge
        // into, so a partial would leave required fields undefined.
        const parsed = profileSchema.safeParse(profile);
        if (!parsed.success) return problem('Profile is incomplete', parsed.error.issues);
        return json({ created: true, profile: repos.profiles.save(parsed.data, at) });
      }

      const patch = profileUpdateSchema.safeParse(profile);
      if (!patch.success) return problem('Invalid profile patch', patch.error.issues);

      const merged = repos.profiles.update(patch.data, at);
      return json({ created: false, profile: merged });
    },
  );

  server.registerTool(
    'parse_resume',
    {
      title: 'Parse a resume and update the profile',
      description:
        'Reads a PDF or DOCX from disk, extracts contact details, tech stack, seniority and years ' +
        'of experience, stores it, and merges the derived fields into the profile. Existing tech ' +
        'stack entries are kept and unioned with what the resume shows. CTC and preferences are ' +
        'never touched — they are not on a resume.',
      inputSchema: {
        path: z.string().describe('Absolute or cwd-relative path to a .pdf or .docx resume.'),
      },
    },
    async ({ path }) => {
      const absolute = resolve(path);
      let bytes: Uint8Array;
      try {
        bytes = await readFile(absolute);
      } catch {
        return problem(`Could not read ${absolute}`);
      }

      const at = now();
      let parsed;
      try {
        parsed = await parseResume(bytes);
      } catch (error) {
        return problem(error instanceof Error ? error.message : 'Could not parse the resume');
      }

      const stored = await repos.resumes.store(
        {
          filename: basename(absolute),
          // From the detected format, not the file extension — what is recorded
          // matches what is actually in the bytes.
          mimeType:
            parsed.format === 'pdf'
              ? 'application/pdf'
              : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          bytes,
          text: parsed.text,
          derived: parsed.derived,
        },
        at,
      );

      const profile = repos.profiles.get();
      if (profile) {
        repos.profiles.attachResume(stored.id, at);
        const patch = profileUpdateSchema.parse(mergePatch(profile, parsed.derived));
        repos.profiles.update(patch, at);
      }

      return json({
        resumeId: stored.id,
        derived: parsed.derived,
        profileUpdated: profile !== null,
        note:
          profile === null
            ? 'Resume stored, but there is no profile to merge into yet — call set_profile.'
            : 'Derived fields merged. Review currentCtc / expectedCtc: they are not on a resume.',
      });
    },
  );

  /* ---------------------------------------------------------------------- */
  /* Sources and searching                                                  */
  /* ---------------------------------------------------------------------- */

  server.registerTool(
    'list_sources',
    {
      title: 'List searchable job sources',
      description:
        'Every source this install knows about, and whether it can actually run. A disabled source ' +
        'carries the reason — usually the name of a missing environment variable. Check this before ' +
        'search_jobs: asking for a source that cannot run is refused outright rather than silently ' +
        'skipped, so that "no results" never quietly means "never searched".',
      inputSchema: {},
    },
    async () =>
      json({
        sources: describeProviders(providers).map(toSourceInfo),
        capabilities: toCapabilities(env),
      }),
  );

  server.registerTool(
    'search_jobs',
    {
      title: 'Start a job search',
      description:
        'Queues a search across the selected sources, scores every listing against the resume, and ' +
        'writes leads. Returns a run id immediately — a run takes minutes. Poll run_status, or pass ' +
        'waitSeconds to block. Note that minScore does NOT filter the run: every scored lead is ' +
        'stored, and the threshold is applied when you read them back with list_leads. That way ' +
        'raising the bar later does not require searching again.',
      inputSchema: {
        sources: z
          .array(z.string())
          .optional()
          .describe('Source ids from list_sources. Defaults to every available source.'),
        waitSeconds: z
          .number()
          .int()
          .min(0)
          .max(MAX_WAIT_MS / 1000)
          .optional()
          .describe(
            'Block until the run finishes, up to this many seconds. 0 (default) returns immediately.',
          ),
      },
    },
    async ({ sources, waitSeconds }) => {
      if (!repos.profiles.exists()) {
        return problem('No profile configured — there is nothing to match against.');
      }

      const active = repos.runs.active();
      if (active) {
        return problem(`Run ${active.id} is already ${active.status}. One run at a time.`, {
          runId: active.id,
        });
      }

      const available = providers
        .filter((provider) => provider.unavailableReason === null)
        .map((provider) => provider.id);

      const requested = (sources as SourceId[] | undefined) ?? available;
      if (requested.length === 0) {
        return problem('No source is available. Check list_sources for the missing credentials.');
      }

      const unusable = providers.filter(
        (provider) => requested.includes(provider.id) && provider.unavailableReason !== null,
      );
      if (unusable.length > 0) {
        return problem(
          'Some of the requested sources cannot run',
          unusable.map((provider) => ({ source: provider.id, reason: provider.unavailableReason })),
        );
      }

      const parsed = searchRequestSchema.safeParse({ sources: requested });
      if (!parsed.success) return problem('Invalid search request', parsed.error.issues);

      const run = repos.runs.create(parsed.data, now());
      queue.enqueue(run.id);

      if (!waitSeconds) {
        return json({ runId: run.id, status: run.status, poll: 'run_status' });
      }

      const settled = await waitForRun(container, run.id, waitSeconds * 1000);
      return json({
        runId: run.id,
        status: settled?.status ?? 'unknown',
        stats: settled?.stats,
        timedOut: settled?.status === 'running' || settled?.status === 'queued',
      });
    },
  );

  server.registerTool(
    'run_status',
    {
      title: 'Check a search run',
      description:
        'Progress, per-source counts and the last few log lines for a run. Omit runId for the most ' +
        'recent one.',
      inputSchema: {
        runId: z.string().optional().describe('Defaults to the latest run.'),
      },
    },
    async ({ runId }) => {
      const run = runId ? repos.runs.get(runId) : (repos.runs.list(1)[0] ?? null);
      if (!run) return problem(runId ? `No run ${runId}` : 'No runs yet.');

      return json({
        run,
        recentLogs: repos.runs
          .logs(run.id, 20)
          .map((entry) => entry.event)
          .filter((event) => event.type === 'log' || event.type === 'progress'),
      });
    },
  );

  server.registerTool(
    'cancel_run',
    {
      title: 'Cancel a search run',
      description: 'Stops a queued or running search. Leads already scored are kept.',
      inputSchema: { runId: z.string() },
    },
    async ({ runId }) => {
      const cancelled = queue.cancel(runId) || repos.runs.cancel(runId, now());
      return json({ cancelled, runId });
    },
  );

  /* ---------------------------------------------------------------------- */
  /* Leads                                                                  */
  /* ---------------------------------------------------------------------- */

  server.registerTool(
    'list_leads',
    {
      title: 'List matched job leads',
      description:
        'Scored leads, newest and highest first by default. minScore is a fraction, not a ' +
        'percentage: 0.85 means an 85% match. Each lead carries the company, role, package, ' +
        'location, tech stack, the direct apply link, and a match breakdown explaining the score.',
      inputSchema: {
        minScore: z.number().min(0).max(1).optional().describe('0.85 = 85% match.'),
        status: z
          .enum(['new', 'saved', 'applied', 'interviewing', 'rejected', 'dismissed'])
          .optional(),
        source: z.string().optional().describe('Restrict to one source id.'),
        company: z.string().optional(),
        remoteOnly: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    async (input) => {
      const query = leadQuerySchema.safeParse(prune(input));
      if (!query.success) return problem('Invalid filter', query.error.issues);

      const page = repos.leads.page(query.data);
      return json({
        total: page.total,
        returned: page.items.length,
        aboveThreshold: page.facets.aboveThreshold,
        leads: page.items.map(summarise),
      });
    },
  );

  server.registerTool(
    'get_lead',
    {
      title: 'Get one lead in full',
      description:
        'The complete lead: full job description, tech stack, salary detail, the match breakdown by ' +
        'dimension, and the enriched company record — website, careers portal, and a careers email ' +
        'when one was actually published. An absent email means none was verified; it is never ' +
        'guessed from the domain.',
      inputSchema: { leadId: z.string() },
    },
    async ({ leadId }) => {
      const lead = repos.leads.get(leadId);
      if (!lead) return problem(`No lead ${leadId}`);
      return json({ lead, company: repos.companies.get(lead.job.company.id) });
    },
  );

  server.registerTool(
    'update_lead',
    {
      title: 'Update a lead',
      description:
        'Set the status (new, saved, applied, interviewing, rejected, dismissed) and/or a note. ' +
        'Status survives re-runs: a lead you marked applied stays applied when the same job is ' +
        'seen again.',
      inputSchema: {
        leadId: z.string(),
        status: z
          .enum(['new', 'saved', 'applied', 'interviewing', 'rejected', 'dismissed'])
          .optional(),
        note: z.string().max(4000).optional(),
      },
    },
    async ({ leadId, status, note }) => {
      const patch = leadUpdateSchema.safeParse(prune({ status, note }));
      if (!patch.success) return problem('Invalid update', patch.error.issues);

      const updated = repos.leads.update(leadId, patch.data, now());
      if (!updated) return problem(`No lead ${leadId}`);
      return json({ lead: summarise(updated) });
    },
  );

  server.registerTool(
    'export_leads',
    {
      title: 'Export leads to a spreadsheet',
      description:
        'Writes matching leads to an XLSX or CSV file and returns the path. The workbook carries ' +
        'every field a lead has, including the JD, the portal link and the direct apply link.',
      inputSchema: {
        format: z.enum(['xlsx', 'csv']).optional().describe('Defaults to xlsx.'),
        minScore: z.number().min(0).max(1).optional(),
        path: z.string().optional().describe('Output path. Defaults to DATA_DIR.'),
      },
    },
    async ({ format, minScore, path }) => {
      const extension = format ?? 'xlsx';
      const query = leadQuerySchema.parse(prune({ minScore, limit: 500 }));

      const leads = [];
      for (let offset = 0; leads.length < MAX_EXPORT_ROWS; offset += 500) {
        const page = repos.leads.page({ ...query, offset });
        leads.push(...page.items);
        if (page.items.length < 500 || leads.length >= page.total) break;
      }

      const target =
        path === undefined
          ? join(env.DATA_DIR, `job-radar-leads-${now().slice(0, 10)}.${extension}`)
          : resolve(path);

      const body =
        extension === 'xlsx'
          ? await exportLeadsXlsx(leads, { generatedAt: now(), minScore: query.minScore })
          : Buffer.from(exportLeadsCsv(leads), 'utf8');

      await writeFile(target, body);
      logger.info({ target, rows: leads.length }, 'exported leads via mcp');
      return json({ path: target, rows: leads.length, format: extension });
    },
  );

  return server;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function json(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/**
 * A refusal the model can act on.
 *
 * `isError` is set so the client renders it as a failure rather than as a result
 * — an assistant that reads "no profile configured" as data will happily go on
 * to call `search_jobs` anyway.
 */
function problem(message: string, details?: unknown): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          { error: message, ...(details === undefined ? {} : { details }) },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}

/** Drops undefined keys so an omitted optional does not overwrite a default. */
function prune(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

/**
 * The fields worth spending tokens on in a list.
 *
 * A full `Lead` carries the entire job description, which for twenty leads is
 * tens of thousands of tokens of context the model did not ask for. `get_lead`
 * returns everything for the one that matters.
 */
function summarise(lead: Lead): Record<string, unknown> {
  return {
    id: lead.id,
    matchPercent: Math.round(lead.match.score * 100),
    confidence: lead.match.confidence,
    title: lead.job.title,
    company: lead.job.company.name,
    location: lead.job.location,
    remote: lead.job.isRemote,
    salary: lead.job.salary,
    source: lead.job.source,
    // "JSearch · via LinkedIn" when an aggregator names the origin board.
    via: lead.job.sourcePublisher,
    applyUrl: lead.job.applyUrl,
    postedAt: lead.job.postedAt,
    status: lead.status,
    matchedSkills: lead.match.matchedSkills,
    missingSkills: lead.match.missingSkills,
  };
}

/** Polls until the run leaves a non-terminal state, or the budget runs out. */
async function waitForRun(
  container: Container,
  runId: string,
  budgetMs: number,
): Promise<{ status: string; stats: unknown } | null> {
  const deadline = Date.now() + Math.min(budgetMs, MAX_WAIT_MS);

  for (;;) {
    const run = container.repos.runs.get(runId);
    if (!run) return null;
    if (run.status !== 'queued' && run.status !== 'running') return run;
    if (Date.now() >= deadline) return run;
    await new Promise((resolve_) => setTimeout(resolve_, POLL_INTERVAL_MS));
  }
}

/**
 * Folds resume-derived fields into a profile patch.
 *
 * Only ever adds. A resume is evidence of what someone has done, not a
 * correction of what they told us they want, so an existing tech stack entry is
 * kept even when the resume does not mention it — the user may have typed it in
 * deliberately.
 */
function mergePatch(
  profile: { preferences: { techStack: string[] } },
  derived: { techStack?: string[]; yearsOfExperience?: number | null },
): Record<string, unknown> {
  const existing = profile.preferences.techStack;
  const seen = new Set(existing.map((skill) => skill.toLowerCase()));
  const techStack = [
    ...existing,
    ...(derived.techStack ?? []).filter((skill) => !seen.has(skill.toLowerCase())),
  ];

  return {
    preferences: { techStack },
    ...(derived.yearsOfExperience == null
      ? {}
      : { application: { yearsOfExperience: derived.yearsOfExperience } }),
  };
}
