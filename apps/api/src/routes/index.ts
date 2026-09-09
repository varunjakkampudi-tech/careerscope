/**
 * Route registration.
 *
 * One plugin per resource, mounted under `/api` by `app.ts`. Each takes the
 * container and pulls what it needs out of it, so a route's dependencies are
 * visible in its first three lines rather than hidden in an import graph.
 *
 * Handlers here are deliberately thin: parse, call a service or a repository,
 * shape the reply. Anything that would need a test of its own belongs in
 * `services/`, where it can be tested without an HTTP request.
 */

import type { FastifyInstance } from 'fastify';
import type { Container } from '../container.js';
import { companiesRoutes } from './companies.js';
import { applicationsRoutes } from './applications.js';
import { exportRoutes } from './export.js';
import { healthRoutes } from './health.js';
import { leadsRoutes } from './leads.js';
import { profileRoutes } from './profile.js';
import { resumeRoutes } from './resume.js';
import { runsRoutes } from './runs.js';
import { searchRoutes } from './search.js';
import { sourcesRoutes } from './sources.js';

export interface RouteOptions {
  container: Container;
}

export async function registerRoutes(app: FastifyInstance, options: RouteOptions): Promise<void> {
  const { container } = options;

  await app.register(healthRoutes, { container });
  await app.register(sourcesRoutes, { container });
  await app.register(profileRoutes, { container });
  await app.register(resumeRoutes, { container });
  await app.register(searchRoutes, { container });
  await app.register(runsRoutes, { container });
  await app.register(leadsRoutes, { container });
  await app.register(companiesRoutes, { container });
  await app.register(exportRoutes, { container });
  await app.register(applicationsRoutes, { container });
}
