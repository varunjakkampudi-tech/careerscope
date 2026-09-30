import { z } from 'zod';

export const inferenceConfigSchema = z
  .object({
    provider: z.literal('ollama').default('ollama'),
    origin: z.string().default('http://127.0.0.1:11434'),
    model: z.enum(['qwen3.5:9b', 'qwen3.5:4b']),
    timeoutMs: z.number().int().min(100).max(300_000).default(300_000),
  })
  .strict();

export function inferenceConfiguration(source: NodeJS.ProcessEnv) {
  return inferenceConfigSchema.parse({
    provider: source.LLM_PROVIDER,
    origin: source.OLLAMA_BASE_URL,
    model: source.OLLAMA_MODEL,
    timeoutMs: source.LLM_TIMEOUT_MS ? Number(source.LLM_TIMEOUT_MS) : undefined,
  });
}

export function inferenceOrigin(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]', 'localhost', 'ollama', 'host.docker.internal'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('Inference requires an approved private Ollama origin');
  }
  return url.origin;
}

const replySchema = z.object({
  model: z.string(),
  done: z.literal(true),
  done_reason: z.literal('stop'),
  message: z.object({ content: z.string() }),
  eval_count: z.number().int().nonnegative(),
  eval_duration: z.number().nonnegative(),
  prompt_eval_count: z.number().int().nonnegative(),
});

let inferenceActive = false;

export class InferenceError extends Error {
  constructor(readonly code: 'cancelled' | 'timeout' | 'invalid') {
    super(`Local inference ${code}`);
  }
}

export class LocalInference {
  readonly config;
  readonly origin: string;

  constructor(
    config: z.input<typeof inferenceConfigSchema>,
    private readonly request = fetch,
  ) {
    this.config = inferenceConfigSchema.parse(config);
    this.origin = inferenceOrigin(this.config.origin);
  }

  async generate<Output>(input: {
    system: string;
    prompt: string;
    format: Record<string, unknown>;
    output: z.ZodType<Output>;
    signal: AbortSignal;
  }) {
    input.signal.throwIfAborted();
    if (inferenceActive) throw new Error('Local inference is busy');
    const format = input.format;
    const bytes = Buffer.byteLength(input.system + input.prompt + JSON.stringify(format));
    if (bytes > 2048) throw new Error('Inference input exceeds the 4096-token context budget');
    inferenceActive = true;
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const signal = AbortSignal.any([input.signal, timeout]);
    const started = performance.now();
    const deadline = Date.now() + this.config.timeoutMs;
    try {
      const response = await this.request(`${this.origin}/api/chat`, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.config.model,
          stream: false,
          think: false,
          keep_alive: 0,
          format,
          messages: [
            { role: 'system', content: input.system },
            { role: 'user', content: input.prompt },
          ],
          options: { temperature: 0, num_ctx: 4096, num_predict: 512 },
        }),
      });
      if (Date.now() >= deadline || signal.aborted) {
        await response.body?.cancel();
        throw new Error('Inference deadline exceeded');
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error('Invalid inference response');
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          signal.throwIfAborted();
          if (Date.now() >= deadline) throw new Error('Inference deadline exceeded');
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 65_536) throw new Error('Inference response too large');
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      signal.throwIfAborted();
      if (Date.now() >= deadline) throw new Error('Inference deadline exceeded');
      const reply = replySchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (reply.model !== this.config.model || reply.prompt_eval_count > 3584) {
        throw new Error('Inference model or context mismatch');
      }
      return {
        output: input.output.parse(JSON.parse(reply.message.content)),
        model: reply.model,
        durationMs: performance.now() - started,
        outputTokens: reply.eval_count,
        tokensPerSecond:
          reply.eval_duration > 0 ? (reply.eval_count * 1e9) / reply.eval_duration : 0,
      };
    } catch {
      if (input.signal.aborted) throw new InferenceError('cancelled');
      if (timeout.aborted || Date.now() >= deadline) throw new InferenceError('timeout');
      throw new InferenceError('invalid');
    } finally {
      inferenceActive = false;
    }
  }
}
