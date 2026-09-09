/**
 * Companies — the enriched employer record behind every lead.
 *
 * Read-only. Company rows are written by the run: `upsertFromJob` records what a
 * board said, then `companyResolver` fills in the website, careers portal and
 * careers email. Letting the UI hand-edit them would put a typed-in address next
 * to a verified one with nothing to tell them apart, and the whole point of the
 * `confidence` fields is that a reader can tell the difference.
 *
 * There is deliberately no `/companies/:id/leads`. "What else is open here" is
 * answered by `GET /leads?company=<name>`, which the drawer links to — the user
 * lands in the leads table with the filter applied and every other control still
 * working, rather than in a detached list that has to reimplement sorting,
 * paging and status changes for itself.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiProblem } from '../errors.js';
import type { RouteOptions } from './index.js';

const SEARCH_LIMIT = 25;

export async function companiesRoutes(app: FastifyInstance, options: RouteOptions): Promise<void> {
  const { repos } = options.container;

  /**
   * Typeahead for the leads filter rail.
   *
   * An empty `q` returns nothing rather than the whole table: the field is a
   * search box, and answering a keystroke-in-progress with 400 companies is
   * both slower and less useful than answering with nothing.
   */
  app.get('/companies', async (request) => {
    const { q } = request.query as { q?: string };
    const term = q?.trim() ?? '';
    return {
      companies: term.length === 0 ? [] : repos.companies.search(term, SEARCH_LIMIT),
      total: repos.companies.count(),
    };
  });

  app.get('/companies/:id', async (request) => {
    const id = idOf(request);
    const company = repos.companies.get(id);
    if (!company) throw ApiProblem.notFound('Company', id);
    return { company };
  });
}

function idOf(request: FastifyRequest): string {
  return (request.params as { id: string }).id;
}
