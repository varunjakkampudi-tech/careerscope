#!/usr/bin/env node
// Refuses to deploy a commit unless CI concluded success for that exact SHA.
//
// The decision lives in `decide` so it can be mutation-tested without a
// network. That matters more than usual here: this is the check that stops a
// commit CI rejected from reaching the public origin, and this repository has
// already shipped six checks that passed because they were unable to look.

const API = 'https://api.github.com';

export const PASS = 'PASS';
export const REFUSE = 'REFUSE';
export const WAIT = 'WAIT';

/**
 * Classify a GitHub "list workflow runs" payload.
 *
 * Anything that is not a legible, completed, successful run is REFUSE or WAIT.
 * There is no path that treats unreadable input as "nothing wrong".
 */
export function decide(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { verdict: REFUSE, reason: 'CI run list was not an object' };
  }

  const total = payload.total_count;
  if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) {
    return { verdict: REFUSE, reason: 'CI run list had no usable total_count' };
  }

  const runs = payload.workflow_runs;
  if (!Array.isArray(runs)) {
    return { verdict: REFUSE, reason: 'CI run list had no workflow_runs array' };
  }

  // A count that disagrees with the array means the page was truncated or the
  // payload is not what it claims. Either way it cannot be reasoned about.
  if (total !== runs.length) {
    return {
      verdict: REFUSE,
      reason: `CI run list is inconsistent: total_count ${total}, ${runs.length} runs returned`,
    };
  }

  if (total === 0) {
    return { verdict: WAIT, reason: 'no CI run recorded for this commit yet' };
  }

  const legible = runs.filter((run) => run && typeof run === 'object');
  if (legible.length !== runs.length) {
    return { verdict: REFUSE, reason: 'CI run list contained an unreadable entry' };
  }

  const latest = legible.reduce((newest, run) =>
    String(run.run_started_at ?? '') >= String(newest.run_started_at ?? '') ? run : newest,
  );

  const status = typeof latest.status === 'string' ? latest.status : '';
  if (status === '') {
    return { verdict: REFUSE, reason: 'latest CI run reported no status' };
  }

  if (status !== 'completed') {
    return { verdict: WAIT, reason: `CI is ${status}` };
  }

  const conclusion = typeof latest.conclusion === 'string' ? latest.conclusion : '';
  if (conclusion === 'success') {
    return { verdict: PASS, reason: `CI passed${latest.html_url ? `: ${latest.html_url}` : ''}` };
  }

  return {
    verdict: REFUSE,
    reason: `CI concluded ${conclusion || 'nothing'}${latest.html_url ? `: ${latest.html_url}` : ''}`,
  };
}

async function fetchRuns({ repository, sha, token }) {
  const url = `${API}/repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${encodeURIComponent(sha)}&per_page=100`;
  const response = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'careerscope-deploy-gate',
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API returned ${response.status}`);
  }
  return response.json();
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const sha = process.env.SHA;
  const token = process.env.GH_TOKEN;
  const deadlineSeconds = Number(process.env.CI_GATE_DEADLINE_SECONDS ?? 1800);
  const intervalSeconds = Number(process.env.CI_GATE_INTERVAL_SECONDS ?? 20);

  for (const [name, value] of [
    ['GITHUB_REPOSITORY', repository],
    ['SHA', sha],
    ['GH_TOKEN', token],
  ]) {
    if (!value) {
      console.error(`::error::${name} is not set. Refusing to deploy.`);
      process.exit(1);
    }
  }

  const expiresAt = Date.now() + deadlineSeconds * 1000;
  for (;;) {
    let payload;
    try {
      payload = await fetchRuns({ repository, sha, token });
    } catch (error) {
      console.error(
        `::error::Could not query CI runs for ${sha}: ${error.message}. Refusing to deploy.`,
      );
      process.exit(1);
    }

    const { verdict, reason } = decide(payload);
    if (verdict === PASS) {
      console.log(`${sha}: ${reason}`);
      return;
    }
    if (verdict === REFUSE) {
      console.error(`::error::${sha}: ${reason}. Refusing to deploy.`);
      process.exit(1);
    }

    if (Date.now() >= expiresAt) {
      console.error(`::error::${sha}: ${reason}, and the deadline expired. Refusing to deploy.`);
      process.exit(1);
    }
    console.log(`${sha}: ${reason}; waiting.`);
    await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
