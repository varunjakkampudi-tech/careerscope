import { Buffer } from 'node:buffer';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import { loadEngineering } from './engineering.mjs';

export const MAX_INPUT_BYTES = 64 * 1024;
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const statuses = new Set(['NOT_STARTED', 'IN_PROGRESS', 'BLOCKED', 'VERIFIED', 'COMPLETE']);
const failure = () => ({
  exitCode: 2,
  output: {
    continue: false,
    systemMessage:
      'CareerScope SessionStart: invalid hook input or engineering configuration. Completion NOT VERIFIED.',
  },
});

export function hookResponse(payload, { state, result }) {
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    (Object.hasOwn(payload, 'hook_event_name') && payload.hook_event_name !== 'SessionStart') ||
    result?.valid !== true ||
    typeof result.complete !== 'boolean' ||
    !statuses.has(state?.status) ||
    (result.complete && state.status !== 'COMPLETE') ||
    (!result.complete && ['COMPLETE', 'VERIFIED'].includes(state.status))
  )
    return failure();
  return {
    exitCode: 0,
    output: {
      continue: true,
      systemMessage: `CareerScope engineering scope status: ${state.status}. Scope completion ${result.complete ? 'VERIFIED by local records only' : 'NOT VERIFIED'}. This is not product, runtime, deployment, or independent execution verification.`,
    },
  };
}

export function evaluateHook(raw, load = loadEngineering) {
  try {
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_INPUT_BYTES)
      return failure();
    const payload = JSON.parse(raw);
    if (
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      (Object.hasOwn(payload, 'hook_event_name') && payload.hook_event_name !== 'SessionStart')
    )
      return failure();
    return hookResponse(payload, load(root));
  } catch {
    return failure();
  }
}

export async function runHook(input, load = loadEngineering) {
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_INPUT_BYTES) return failure();
      chunks.push(bytes);
    }
    return evaluateHook(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
      load,
    );
  } catch {
    return failure();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const response = await runHook(process.stdin);
  process.stdout.write(`${JSON.stringify(response.output)}\n`);
  if (response.exitCode === 2)
    process.stderr.write('Invalid SessionStart input or engineering configuration.\n');
  process.exitCode = response.exitCode;
}
