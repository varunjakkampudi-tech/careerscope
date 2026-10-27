import { MATCH_DIMENSION_LABELS, MATCH_WEIGHTS, type MatchDimension } from '@careerscope/shared';
import Link from 'next/link';
import styles from './page.module.css';

const dimensions: Record<MatchDimension, string> = {
  skills:
    'Compares skills named in the job description with skills available in your saved profile and the resume evidence used for this search.',
  title: 'Compares the job title with the target roles you saved in your profile.',
  seniority:
    'Estimates how the role level described in the posting compares with your stated experience level.',
  experience:
    'Compares a stated experience range in the posting with the experience information you provided.',
  location:
    'Considers the posting location or remote status alongside your saved location preferences.',
  compensation:
    'Compares disclosed compensation with your saved expectation. An undisclosed salary is treated as unknown, not as a mismatch.',
  recency:
    'Uses the posting date to estimate freshness. If the date is unknown, the score does not treat that as proof the job is old.',
};

export default function MatchingTransparencyPage() {
  const dimensionsInOrder = Object.keys(MATCH_WEIGHTS) as MatchDimension[];

  return (
    <article className={styles.page}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>CareerScope matching</p>
        <h1>How job matching works</h1>
        <p>
          The match score is a decision aid based on the job information and career details you have
          provided. It is not a hiring decision or a guarantee of eligibility, an interview, or an
          offer.
        </p>
      </header>

      <section className={styles.panel} aria-labelledby="score-heading">
        <h2 id="score-heading">What contributes to the score</h2>
        <p>
          CareerScope combines seven signals using the weights below. The labels and weights come
          from the same shared definitions used by the matching engine, so this page does not
          maintain a second set of scoring constants.
        </p>
        <dl className={styles.dimensions}>
          {dimensionsInOrder.map((dimension) => (
            <div
              className={styles.dimension}
              data-dimension={dimension}
              data-testid="matching-dimension"
              key={dimension}
            >
              <dt>
                <span>{MATCH_DIMENSION_LABELS[dimension]}</span>
                <strong>{Math.round(MATCH_WEIGHTS[dimension] * 100)}%</strong>
              </dt>
              <dd>{dimensions[dimension]}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className={styles.panel} aria-labelledby="limits-heading">
        <h2 id="limits-heading">What the score does—and does not—tell you</h2>
        <ul className={styles.limits}>
          <li>
            Missing information stays unknown. For example, a posting without a disclosed salary is
            not treated as proof that the role falls outside your expectations.
          </li>
          <li>
            Some saved constraints can mark a job as excluded and give it a zero score. The job
            remains visible for you to review; CareerScope does not submit an application or make
            the decision for you.
          </li>
          <li>
            When a full job description is unavailable, the score is capped at 80% and marked as low
            confidence. A high score therefore should not be inferred from a short snippet.
          </li>
          <li>
            Matching uses the deterministic scoring rules identified with each result. AI assistance
            is not enabled in this build and does not change these scores.
          </li>
          <li>
            Scores can change when your saved profile, the job information, or the scoring version
            changes. Use the match breakdown to see the evidence for an individual job.
          </li>
        </ul>
      </section>

      <p className={styles.backLink}>
        <Link href="/jobs">Return to job discovery</Link>
      </p>
    </article>
  );
}
