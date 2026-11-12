import { localizedText, localizedValue, useInterfaceLocale } from '../lib/locale';
import { assessResumeQuality } from '../lib/resume-quality';
import type { ResumeProposal } from '../lib/api-schemas';
import styles from './resume-quality-diagnostics.module.css';

export default function ResumeQualityDiagnostics({
  text,
  derived,
}: {
  text: string;
  derived: ResumeProposal;
}) {
  const locale = useInterfaceLocale();
  const report = assessResumeQuality(text, derived);
  const sectionLabels = {
    skills: localizedText(locale, 'resumeQualitySkills'),
    experience: localizedText(locale, 'resumeQualityExperience'),
    education: localizedText(locale, 'resumeQualityEducation'),
  };

  return (
    <section
      className={styles.report}
      aria-labelledby="resume-quality-heading"
      aria-describedby="resume-quality-description"
    >
      <h3 id="resume-quality-heading">{localizedText(locale, 'resumeQualityHeading')}</h3>
      <p id="resume-quality-description">{localizedText(locale, 'resumeQualityDescription')}</p>
      <p>{localizedValue(locale, 'resumeQualityCharacterCount', report.extractedCharacters)}</p>
      <ul>
        {report.checks.map(({ section, detected }) => (
          <li key={section}>
            <span>{sectionLabels[section]}</span>
            <span>
              {localizedText(
                locale,
                detected ? 'resumeQualityDetected' : 'resumeQualityNotDetected',
              )}
            </span>
          </li>
        ))}
      </ul>
      <p className={styles.guidance}>{localizedText(locale, 'resumeQualityGuidance')}</p>
    </section>
  );
}
