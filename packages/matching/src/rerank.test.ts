import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { Job, MatchBreakdown } from '@job-radar/shared';
import {
  MAX_DESCRIPTION_CHARS,
  RERANK_MAX_TOKENS,
  rerankLeads,
  type RerankClient,
  type RerankInput,
} from './rerank.js';
import { scoreJob } from './score.js';
import { NEAR_EXACT_JD, NOW, SNIPPET_JD, candidate, job } from './matching.fixtures.js';

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

type Params = Anthropic.MessageCreateParamsNonStreaming;
type Reply = { stop_reason: string | null; parsed_output: unknown };

/** A client that records what it was asked and replies however the test wants. */
function stub(handler: (params: Params, callIndex: number) => Reply | Promise<Reply>) {
  const calls: Params[] = [];
  const client: RerankClient = {
    messages: {
      parse: async (params) => {
        calls.push(params);
        return handler(params, calls.length - 1);
      },
    },
  };
  return { client, calls };
}

/** The posting ids in a request, read back out of the rendered prompt. */
function idsIn(params: Params): string[] {
  const content = params.messages[0]?.content;
  const text = typeof content === 'string' ? content : '';
  return [...text.matchAll(/<posting id="([^"]+)">/g)].map((m) => m[1]!);
}

/** Reply with the same verdict for every posting the request contained. */
function verdictFor(params: Params, score: number, rationale = 'Ships the same surfaces.'): Reply {
  return {
    stop_reason: 'end_turn',
    parsed_output: {
      assessments: idsIn(params).map((id) => ({ id, score, rationale, missingSkills: [] })),
    },
  };
}

const opts = { now: NOW, windowDays: 30 };

function lead(
  id: string,
  jobOverrides: Partial<Job> = {},
  matchOverrides: Partial<MatchBreakdown> = {},
): RerankInput {
  const posting = job({
    id,
    title: 'Full Stack Software Engineer',
    descriptionText: NEAR_EXACT_JD,
    ...jobOverrides,
  });
  const match = scoreJob(posting, candidate(), opts);
  return { job: posting, match: { ...match, ...matchOverrides } };
}

/** A snippet-only lead — genuinely low confidence, not just labelled so. */
function thinLead(id: string): RerankInput {
  return lead(id, { descriptionText: SNIPPET_JD, hasFullDescription: false });
}

/* -------------------------------------------------------------------------- */
/* The blend                                                                  */
/* -------------------------------------------------------------------------- */

describe('rerankLeads', () => {
  it('blends the model score into the lead', async () => {
    const input = [lead('a')];
    const { client } = stub((params) =>
      verdictFor(params, 0.92, 'Owned a design system end to end.'),
    );

    const [out] = await rerankLeads(input, candidate(), { client });

    expect(out!.match.llmScore).toBe(0.92);
    expect(out!.match.llmRationale).toBe('Owned a design system end to end.');
    expect(out!.match.score).toBeCloseTo(0.6 * input[0]!.match.heuristicScore + 0.4 * 0.92, 4);
  });

  it('keeps the deterministic score recorded alongside the blend', async () => {
    const input = [lead('a')];
    const { client } = stub((params) => verdictFor(params, 0.1));

    const [out] = await rerankLeads(input, candidate(), { client });

    // The heuristic is preserved verbatim, so the drawer can show both numbers
    // and the blend stays auditable.
    expect(out!.match.heuristicScore).toBe(input[0]!.match.heuristicScore);
    expect(out!.match.dimensions).toEqual(input[0]!.match.dimensions);
  });

  it('returns leads in the order it received them, not in score order', async () => {
    const input = [lead('a'), lead('b'), lead('c')];
    const { client } = stub((params) => verdictFor(params, 0.8));

    const out = await rerankLeads(input, candidate(), { client });

    expect(out.map((item) => item.job.id)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate what it was given', async () => {
    const input = [lead('a')];
    const before = structuredClone(input[0]!.match);
    const { client } = stub((params) => verdictFor(params, 0.99));

    await rerankLeads(input, candidate(), { client });

    expect(input[0]!.match).toEqual(before);
  });

  it('clamps a score the model put outside 0..1', async () => {
    const { client } = stub((params) => verdictFor(params, 1.7));
    const [out] = await rerankLeads([lead('a')], candidate(), { client });
    expect(out!.match.llmScore).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* What gets sent                                                             */
/* -------------------------------------------------------------------------- */

describe('rerankLeads — selection', () => {
  it('never sends an excluded lead', async () => {
    const gating = candidate({ excludeKeywords: ['Sales'] });
    const posting = job({ id: 'gated', title: 'Sales Engineer', descriptionText: NEAR_EXACT_JD });
    const excluded: RerankInput = { job: posting, match: scoreJob(posting, gating, opts) };
    expect(excluded.match.excludedReason).not.toBeNull();

    const { client, calls } = stub((params) => verdictFor(params, 0.9));
    const [out] = await rerankLeads([excluded], gating, { client });

    expect(calls).toHaveLength(0);
    expect(out!.match).toEqual(excluded.match);
  });

  it('never sends a snippet-only lead', async () => {
    // Two lines of teaser cannot support a semantic judgement, and a rationale
    // drawn from them would read in the drawer as though we knew.
    const { client, calls } = stub((params) => verdictFor(params, 0.9));
    const [out] = await rerankLeads([thinLead('thin')], candidate(), { client });

    expect(calls).toHaveLength(0);
    expect(out!.match.llmScore).toBeNull();
  });

  it('says in the log how many it skipped', async () => {
    const onWarning = vi.fn();
    const { client } = stub((params) => verdictFor(params, 0.9));

    await rerankLeads([lead('a'), thinLead('thin')], candidate(), { client, onWarning });

    expect(onWarning).toHaveBeenCalledWith(expect.stringMatching(/Skipped 1 lead/));
  });

  it('takes the strongest leads when there are more than topN', async () => {
    const strong = lead('strong');
    const weak = lead('weak', { title: 'Data Scientist', location: 'Pune, India' });
    expect(weak.match.heuristicScore).toBeLessThan(strong.match.heuristicScore);

    const { client, calls } = stub((params) => verdictFor(params, 0.9));
    await rerankLeads([weak, strong], candidate(), { client, topN: 1 });

    expect(idsIn(calls[0]!)).toEqual(['strong']);
  });

  it('splits a long shortlist into batches', async () => {
    const input = Array.from({ length: 20 }, (_, i) => lead(`job-${i}`));
    const { client, calls } = stub((params) => verdictFor(params, 0.9));

    await rerankLeads(input, candidate(), { client, batchSize: 8, concurrency: 1 });

    expect(calls.map((call) => idsIn(call).length)).toEqual([8, 8, 4]);
    // Every lead was assessed exactly once.
    expect(calls.flatMap(idsIn)).toHaveLength(20);
  });

  it('makes no request at all when nothing is eligible', async () => {
    const { client, calls } = stub((params) => verdictFor(params, 0.9));
    await rerankLeads([thinLead('thin')], candidate(), { client });
    await rerankLeads([], candidate(), { client });
    expect(calls).toHaveLength(0);
  });

  it('stops before the first call when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { client, calls } = stub((params) => verdictFor(params, 0.9));

    const out = await rerankLeads([lead('a')], candidate(), { client, signal: controller.signal });

    expect(calls).toHaveLength(0);
    expect(out[0]!.match.llmScore).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* The request itself                                                         */
/* -------------------------------------------------------------------------- */

describe('rerankLeads — request shape', () => {
  async function capture(): Promise<Params> {
    const { client, calls } = stub((params) => verdictFor(params, 0.9));
    await rerankLeads([lead('a')], candidate(), { client });
    return calls[0]!;
  }

  it('asks Opus 5 with adaptive thinking and low effort', async () => {
    const params = await capture();
    expect(params.model).toBe('claude-opus-5');
    expect(params.thinking).toEqual({ type: 'adaptive' });
    expect(params.output_config?.effort).toBe('low');
    expect(params.output_config?.format).toBeDefined();
  });

  it('stays under the SDK ceiling that would force streaming', async () => {
    // calculateNonstreamingTimeout throws above roughly 21k tokens.
    expect((await capture()).max_tokens).toBe(RERANK_MAX_TOKENS);
    expect(RERANK_MAX_TOKENS).toBeLessThan(21_000);
  });

  it('puts the resume in a cached system block', async () => {
    const system = (await capture()).system as Anthropic.TextBlockParam[];

    expect(system).toHaveLength(2);
    expect(system[1]!.text).toContain('Full Stack Software Engineer with 4 years');
    // The breakpoint sits on the last static block, so the rules and the resume
    // are cached together and only the postings change between batches.
    expect(system[1]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(system[0]!.cache_control).toBeUndefined();
  });

  it('keeps the volatile postings out of the cached prefix', async () => {
    const params = await capture();
    const system = (params.system as Anthropic.TextBlockParam[]).map((b) => b.text).join('\n');
    expect(system).not.toContain('<posting');
    expect(params.messages[0]!.content).toContain('<posting id="a">');
  });

  it('marks a clipped description instead of clipping it silently', async () => {
    const long = `${NEAR_EXACT_JD}\n${'filler text. '.repeat(1000)}`;
    expect(long.length).toBeGreaterThan(MAX_DESCRIPTION_CHARS);

    const { client, calls } = stub((params) => verdictFor(params, 0.9));
    await rerankLeads([lead('a', { descriptionText: long })], candidate(), { client });

    const content = calls[0]!.messages[0]!.content as string;
    expect(content).toContain('truncated for length');
    expect(content.length).toBeLessThan(long.length);
  });
});

/* -------------------------------------------------------------------------- */
/* Degradation — the property that matters most                               */
/* -------------------------------------------------------------------------- */

describe('rerankLeads — failure degrades to the heuristic', () => {
  async function expectDegraded(reply: () => Reply | Promise<Reply>) {
    const input = [lead('a')];
    const onWarning = vi.fn();
    const { client } = stub(reply);

    const [out] = await rerankLeads(input, candidate(), { client, onWarning });

    expect(out!.match.score).toBe(input[0]!.match.score);
    expect(out!.match.llmScore).toBeNull();
    expect(onWarning).toHaveBeenCalled();
    return onWarning;
  }

  it('survives a network error', async () => {
    const warn = await expectDegraded(() => {
      throw new Error('socket hang up');
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('socket hang up'));
  });

  it('survives a refusal', async () => {
    const warn = await expectDegraded(() => ({ stop_reason: 'refusal', parsed_output: null }));
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/declined/));
  });

  it('survives a truncated response', async () => {
    const warn = await expectDegraded(() => ({ stop_reason: 'max_tokens', parsed_output: null }));
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/cut off/));
  });

  it('survives output that did not parse', async () => {
    await expectDegraded(() => ({ stop_reason: 'end_turn', parsed_output: null }));
  });

  it('survives output of the wrong shape', async () => {
    // A stubbed or drifting client can return anything; the schema is re-checked
    // rather than trusted.
    const warn = await expectDegraded(() => ({
      stop_reason: 'end_turn',
      parsed_output: { assessments: [{ id: 'a', score: 'very good' }] },
    }));
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/did not match the schema/));
  });

  it('loses only the failed batch, not the whole shortlist', async () => {
    const input = Array.from({ length: 4 }, (_, i) => lead(`job-${i}`));
    const { client } = stub((params, index) => {
      if (index === 0) throw new Error('rate limited');
      return verdictFor(params, 0.9);
    });

    const out = await rerankLeads(input, candidate(), { client, batchSize: 2, concurrency: 1 });

    expect(out.filter((item) => item.match.llmScore === null)).toHaveLength(2);
    expect(out.filter((item) => item.match.llmScore === 0.9)).toHaveLength(2);
  });

  it('never throws, even when the logger does', async () => {
    const onWarning = () => {
      throw new Error('the log sink is down');
    };
    const { client } = stub(() => {
      throw new Error('upstream is down');
    });

    await expect(
      rerankLeads([lead('a')], candidate(), { client, onWarning }),
    ).resolves.toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Partial and malformed verdicts                                             */
/* -------------------------------------------------------------------------- */

describe('rerankLeads — partial verdicts', () => {
  it('applies what came back and leaves the rest on the heuristic', async () => {
    const input = [lead('a'), lead('b')];
    const { client } = stub(() => ({
      stop_reason: 'end_turn',
      parsed_output: {
        assessments: [{ id: 'a', score: 0.9, rationale: 'Good.', missingSkills: [] }],
      },
    }));
    const onWarning = vi.fn();

    const out = await rerankLeads(input, candidate(), { client, onWarning });

    expect(out[0]!.match.llmScore).toBe(0.9);
    expect(out[1]!.match.llmScore).toBeNull();
    expect(onWarning).toHaveBeenCalledWith(expect.stringMatching(/no verdict for 1 of 2/));
  });

  it('ignores a verdict for an id it never sent', async () => {
    const { client } = stub(() => ({
      stop_reason: 'end_turn',
      parsed_output: {
        assessments: [
          { id: 'a', score: 0.9, rationale: 'Good.', missingSkills: [] },
          { id: 'hallucinated', score: 1, rationale: 'Invented.', missingSkills: [] },
        ],
      },
    }));

    const out = await rerankLeads([lead('a')], candidate(), { client });

    expect(out).toHaveLength(1);
    expect(out[0]!.job.id).toBe('a');
    expect(out[0]!.match.llmScore).toBe(0.9);
  });

  it('trims whitespace off the rationale before it reaches the UI', async () => {
    const { client } = stub((params) => verdictFor(params, 0.9, '  Strong React depth.\n'));
    const [out] = await rerankLeads([lead('a')], candidate(), { client });
    expect(out!.match.llmRationale).toBe('Strong React depth.');
  });
});
