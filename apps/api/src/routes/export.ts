/**
 * Export.
 *
 * The same filters as `GET /leads`, but without paging: an export of "page 1 of
 * 9" is not an export. `limit` and `offset` from the query string are replaced
 * with a single hard ceiling here, so a filter that matches everything produces
 * a large file rather than an out-of-memory error.
 *
 * Both formats are built in memory and sent whole. XLSX has no streaming writer
 * worth the complexity at this size, and a CSV that streams would still need the
 * full result set to know its own `content-length`. At the cap below, the
 * workbook is a few megabytes.
 *
 * These two routes are on the rate limiter's allow-list (see `app.ts`): a user
 * who exports twice, reads the file and exports again should not be told to slow
 * down, and the cost is bounded by the cap rather than by the request count.
 */

import { leadQuerySchema } from '@job-radar/shared';
import type { Lead, LeadQuery } from '@job-radar/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { LeadRepo } from '../db/repo/index.js';
import { parseOrThrow } from '../errors.js';
import { exportLeadsCsv, exportLeadsXlsx } from '../services/exporter.js';
import { now } from '../util/time.js';
import type { RouteOptions } from './index.js';

/**
 * Enough for every lead a single-user install will realistically hold, and
 * small enough that the workbook stays inside a normal request's memory.
 */
const MAX_EXPORT_ROWS = 5_000;

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export async function exportRoutes(app: FastifyInstance, options: RouteOptions): Promise<void> {
  const { repos } = options.container;

  app.get('/export/leads.xlsx', async (request, reply) => {
    const query = parseOrThrow(leadQuerySchema, request.query, 'export filter');
    const leads = collect(repos.leads, query);

    const workbook = await exportLeadsXlsx(leads, {
      generatedAt: now(),
      minScore: query.minScore,
    });

    request.log.info({ rows: leads.length }, 'exported leads workbook');
    return send(reply, workbook, XLSX_MIME, filename('xlsx'));
  });

  app.get('/export/leads.csv', async (request, reply) => {
    const query = parseOrThrow(leadQuerySchema, request.query, 'export filter');
    const leads = collect(repos.leads, query);

    // `exportLeadsCsv` emits a UTF-8 BOM, which is what makes Excel open a
    // file with accented company names correctly instead of as mojibake.
    const csv = exportLeadsCsv(leads);

    request.log.info({ rows: leads.length }, 'exported leads csv');
    return send(reply, Buffer.from(csv, 'utf8'), 'text/csv; charset=utf-8', filename('csv'));
  });
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Every matching lead, read in pages.
 *
 * `LeadRepo.page` caps `limit` at 500 by schema, so this loops rather than
 * asking for everything at once — and stops at {@link MAX_EXPORT_ROWS} so a
 * pathological filter cannot walk the entire table into memory.
 */
function collect(leads: LeadRepo, query: LeadQuery): Lead[] {
  const all: Lead[] = [];
  const pageSize = 500;

  for (let offset = 0; all.length < MAX_EXPORT_ROWS; offset += pageSize) {
    const page = leads.page({ ...query, limit: pageSize, offset });
    all.push(...page.items);
    if (page.items.length < pageSize || all.length >= page.total) break;
  }

  return all.length > MAX_EXPORT_ROWS ? all.slice(0, MAX_EXPORT_ROWS) : all;
}

function send(reply: FastifyReply, body: Buffer, mime: string, name: string): FastifyReply {
  return (
    reply
      .header('content-type', mime)
      .header('content-disposition', `attachment; filename="${name}"`)
      // The file is generated per request from live data; a cached copy would be
      // stale the moment the next run finishes.
      .header('cache-control', 'no-store')
      .send(body)
  );
}

/** `job-radar-leads-2026-09-05.xlsx` — sortable, and unique per day. */
function filename(extension: string): string {
  return `job-radar-leads-${now().slice(0, 10)}.${extension}`;
}
