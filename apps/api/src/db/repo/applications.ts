import { randomUUID } from 'node:crypto';
import type { Db } from '../index.js';
import { ApiProblem } from '../../errors.js';
import {
  applicationRunSchema,
  canTransitionApplication,
  type ApplicationRun,
  type ApplicationStatus,
} from '../../services/applicationState.js';

export class ApplicationRepo {
  constructor(private readonly db: Db) {}

  get(id: string): ApplicationRun | null {
    const row = this.db.get('SELECT data FROM application_runs WHERE id = :id', { id });
    return row ? applicationRunSchema.parse(JSON.parse(String(row['data']))) : null;
  }

  list(leadId: string): ApplicationRun[] {
    return this.db
      .all(
        'SELECT data FROM application_runs WHERE lead_id = :leadId ORDER BY created_at DESC, rowid DESC LIMIT 20',
        { leadId },
      )
      .map((row) => applicationRunSchema.parse(JSON.parse(String(row['data']))));
  }

  active(): ApplicationRun | null {
    const row = this.db.get(
      "SELECT data FROM application_runs WHERE status IN ('running','needs_input','ready','submitting') LIMIT 1",
    );
    return row ? applicationRunSchema.parse(JSON.parse(String(row['data']))) : null;
  }

  recent(): ApplicationRun[] {
    return this.db
      .all('SELECT data FROM application_runs ORDER BY created_at DESC LIMIT 50')
      .map((row) => applicationRunSchema.parse(JSON.parse(String(row['data']))));
  }

  create(leadId: string, at: string, retryOf?: string): ApplicationRun {
    if (this.active())
      throw ApiProblem.conflict('An application is already active. Finish or cancel it first.');
    if (
      this.db.get(
        "SELECT id FROM application_runs WHERE lead_id = :leadId AND status = 'submitted' LIMIT 1",
        { leadId },
      )
    ) {
      throw ApiProblem.conflict('This job already has a submitted application.');
    }
    const previous = this.list(leadId)[0];
    if (previous?.outcomeUnknown && retryOf !== previous.id) {
      throw ApiProblem.conflict(
        'Previous submission outcome is unknown. Check the employer portal and acknowledge that attempt before retrying.',
      );
    }
    if (retryOf && (!previous?.outcomeUnknown || retryOf !== previous.id)) {
      throw ApiProblem.conflict(
        'This retry acknowledgment is no longer current. Refresh application status.',
      );
    }
    const run: ApplicationRun = {
      id: randomUUID(),
      leadId,
      status: 'running',
      createdAt: at,
      updatedAt: at,
      events: [{ at, message: 'Starting Copilot application agent.' }],
      currentUrl: null,
      question: null,
      confirmation: null,
      requestId: null,
      outcomeUnknown: false,
      retryOf: retryOf ?? null,
    };
    this.db.run(
      'INSERT INTO application_runs (id, lead_id, status, data, created_at) VALUES (:id, :leadId, :status, :data, :at)',
      { id: run.id, leadId, status: run.status, data: run, at },
    );
    return run;
  }

  update(
    id: string,
    status: ApplicationStatus,
    message: string,
    at: string,
    patch: Partial<
      Pick<ApplicationRun, 'currentUrl' | 'question' | 'confirmation' | 'requestId'>
    > = {},
  ): ApplicationRun {
    const run = this.get(id);
    if (!run) throw ApiProblem.notFound('Application', id);
    if (run.status !== status && !canTransitionApplication(run.status, status)) {
      throw ApiProblem.conflict(`Cannot change application from ${run.status} to ${status}.`);
    }
    const next = applicationRunSchema.parse({
      ...run,
      ...patch,
      status,
      outcomeUnknown: status === 'failed' && (run.outcomeUnknown || run.status === 'submitting'),
      updatedAt: at,
      events: [...run.events, { at, message: message.slice(0, 2000) }].slice(-200),
    });
    this.db.run('UPDATE application_runs SET status = :status, data = :data WHERE id = :id', {
      id,
      status,
      data: next,
    });
    return next;
  }

  reap(at: string): void {
    const run = this.active();
    if (!run) return;
    const message =
      run.status === 'submitting'
        ? 'Server restarted during submission. Outcome unknown; check the employer portal before retrying.'
        : 'Server restarted. Browser session ended; start again after checking the employer portal.';
    this.update(
      run.id,
      run.status === 'submitting' || run.status === 'running' ? 'failed' : 'cancelled',
      message,
      at,
    );
  }
}
