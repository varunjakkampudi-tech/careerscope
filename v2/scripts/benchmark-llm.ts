import { benchmarkInference } from '../packages/core/src/inference-benchmark.js';
import { inferenceConfiguration, LocalInference } from '../packages/core/src/inference.js';

const control = new AbortController();
const stop = () => control.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  const client = new LocalInference(inferenceConfiguration(process.env));
  const report = await benchmarkInference(client, control.signal);
  console.log(JSON.stringify(report, null, 2));
  if (!report.fixtureChecksPassed) process.exitCode = 1;
} catch {
  console.error(
    'Local inference benchmark unavailable, cancelled or misconfigured. No activation performed.',
  );
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
