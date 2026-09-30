import type { CollectedJob } from '@careerscope/core';

export default function MatchEvidence({ match }: { match: NonNullable<CollectedJob['match']> }) {
  return (
    <section className="match-evidence" aria-label="Match evidence">
      {/* A visually-styled label, not a heading: this widget is embedded at
          different heading depths across the app (a job-list accordion vs a
          saved-lead detail panel), and a fixed <h#> here would be correct in
          one context and skip a level in the other. The section already has
          its own accessible name via aria-label. */}
      <p className="match-evidence-title">Match Breakdown</p>
      {/* CS-18: a hard exclusion must say which rule excluded the listing,
          never just present a low-looking number with no explanation. */}
      {match.excludedReason && (
        <p className="match-excluded" role="alert">
          Excluded: {match.excludedReason}
        </p>
      )}
      <div className="match-flags">
        {match.confidence === 'low' && (
          <span>Limited description — score capped, treat as low-confidence</span>
        )}
        {match.flaggedCompany && <span>Do Not Apply</span>}
      </div>
      <dl className="match-dimensions">
        {Object.entries(match.dimensions).map(([name, dimension]) => (
          <div key={name}>
            <dt>
              {name}
              <strong>{Math.round(dimension.score * 100)}%</strong>
            </dt>
            <dd>{dimension.reason}</dd>
          </div>
        ))}
      </dl>
      <dl className="match-skills">
        <div>
          <dt>Matched Skills</dt>
          <dd>{match.matchedSkills.join(', ') || 'None identified'}</dd>
        </div>
        <div>
          <dt>Missing Skills</dt>
          <dd>{match.missingSkills.join(', ') || 'None identified'}</dd>
        </div>
        <div>
          <dt>Resume</dt>
          {/* resumeConsidered=false must read as "no resume on file", never as
              "resume matched nothing" - a candidate with no resume and one
              whose resume simply didn't match this listing look different. */}
          <dd>
            {!match.resumeConsidered
              ? 'No resume on file — scored from your saved profile only'
              : match.resumeSkills.length > 0
                ? `Resume contributed: ${match.resumeSkills.join(', ')}`
                : 'Resume on file — none of its skills matched this listing'}
          </dd>
        </div>
      </dl>
    </section>
  );
}
