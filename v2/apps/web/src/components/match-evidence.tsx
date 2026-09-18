import type { CollectedJob } from '@careerscope/core';

export default function MatchEvidence({ match }: { match: NonNullable<CollectedJob['match']> }) {
  return (
    <section className="match-evidence" aria-label="Match evidence">
      <h4>Match Breakdown</h4>
      <div className="match-flags">
        {match.confidence === 'low' && <span>Limited Description</span>}
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
      </dl>
    </section>
  );
}
