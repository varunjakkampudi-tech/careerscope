import { ApplicationProgress } from '../components/ApplicationPanel';
import { useApplications } from '../lib/applications';
import { useLead } from '../lib/queries';
import { Alert, ExternalLink } from '../components/ui';

export function Applications() {
  const applications = useApplications();
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold text-ink">Applications</h1>
      {applications.isPending ? (
        <p role="status" className="mt-4 text-sm text-muted">
          Loading applications...
        </p>
      ) : null}
      {applications.error ? (
        <Alert tone="bad" title="Could not load applications">
          {applications.error.message}
        </Alert>
      ) : null}
      {applications.data?.runs.length === 0 ? (
        <p className="mt-4 text-sm text-muted">No applications yet.</p>
      ) : null}
      {applications.data?.runs.map((run) => (
        <article key={run.id} className="mt-6 border-t border-border pt-4">
          <ApplicationTitle leadId={run.leadId} />
          <ApplicationProgress run={run} />
        </article>
      ))}
    </div>
  );
}

function ApplicationTitle({ leadId }: { leadId: string }) {
  const lead = useLead(leadId);
  return (
    <h2 className="break-words text-base font-semibold text-ink">
      {lead.data ? (
        <ExternalLink href={lead.data.lead.job.applyUrl}>
          {lead.data.lead.job.title} at {lead.data.lead.job.company.name}
        </ExternalLink>
      ) : (
        'Application'
      )}
    </h2>
  );
}
