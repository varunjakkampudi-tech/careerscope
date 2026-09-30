import type { AiConfig } from './ai-provider.js';
import { requestCompletion } from './ai-provider.js';
import type { PreparationReport } from './preparation.js';

/**
 * CS-48's single real reference use case: an AI-elaborated coaching note for
 * one check or question already produced by the deterministic rules-v1
 * preparation engine (preparation.ts). Chosen over lead-note summarization
 * as the first use case specifically because PreparationReport is already a
 * schema-bounded, fully-vetted allowlist (System Designer finding 7) - every
 * field this sends to OpenRouter is one that preparation.ts itself already
 * decided is safe to compute and show the owner, not a new allowlist built
 * from scratch. Confirmed by reading preparation.ts directly: no email,
 * phone, portfolio URL, resume text or compensation ever appears in these
 * fields.
 *
 * This function only ever reads already-computed PreparationReport data and
 * asks the model to phrase it more helpfully. It does not, and structurally
 * cannot, feed anything into matching, scoring, ranking, exclusions,
 * deduplication, job identity, application/auto-apply or authorization -
 * those modules do not import this file or ai-provider.ts at all (enforced
 * by a real structural test, not merely by convention).
 */

export type ElaborationTarget =
  | { kind: 'check'; id: string; title: string; detail: string; evidence: string[] }
  | { kind: 'question'; id: string; question: string; evidence: string[] };

/**
 * Finds the requested check or question by id within an already-computed
 * report. Returns null (not a thrown error) when absent, so the route layer
 * can produce an honest 404 rather than a 500 - this is the "profile
 * changed between view and click" case System Designer finding 6 asked to
 * be handled with the existing 404 idiom.
 */
export function findElaborationTarget(
  report: PreparationReport,
  checkId: string,
): ElaborationTarget | null {
  const check = report.checks.find((entry) => entry.id === checkId);
  if (check) {
    return {
      kind: 'check',
      id: check.id,
      title: check.title,
      detail: check.detail,
      evidence: check.evidence.map((item) => item.value),
    };
  }
  const question = report.questions.find((entry) => entry.id === checkId);
  if (question) {
    return {
      kind: 'question',
      id: question.id,
      question: question.question,
      evidence: question.evidence.map((item) => item.value),
    };
  }
  return null;
}

const SYSTEM_PROMPT =
  'You are a career-preparation assistant for a private, single-owner job search tool. ' +
  'Given one already-computed checklist item or practice question and its supporting ' +
  'evidence values, write 2-4 sentences of plain, encouraging, concrete coaching. ' +
  'Do not invent facts, qualifications, dates or outcomes not present in the input. ' +
  'Do not make hiring predictions or claims about interview success. Plain text only, ' +
  'no markdown, no headings, no lists.';

function buildUserPrompt(target: ElaborationTarget): string {
  const evidenceLine = target.evidence.length
    ? `Evidence: ${target.evidence.join('; ')}`
    : 'Evidence: none recorded.';
  if (target.kind === 'check') {
    return `Checklist item: ${target.title}\nExisting guidance: ${target.detail}\n${evidenceLine}`;
  }
  return `Practice question: ${target.question}\n${evidenceLine}`;
}

export type ElaborationResult = {
  text: string;
  source: 'ai';
  model: string;
};

/**
 * The only function that actually calls OpenRouter for this use case. Every
 * failure from ai-provider.ts propagates as-is (AiProviderError) - the
 * caller (the API route) decides how to present each distinct failure kind,
 * this function does not swallow or reinterpret them.
 */
export async function elaborate(
  config: AiConfig,
  target: ElaborationTarget,
): Promise<ElaborationResult> {
  const text = await requestCompletion(config, {
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: buildUserPrompt(target),
    maxOutputTokens: 220,
  });
  return { text, source: 'ai', model: config.model };
}
