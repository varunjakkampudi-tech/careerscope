import type { StructuredRerankClient } from '@job-radar/matching';
import { z } from 'zod';

const replySchema = z.object({
  done: z.literal(true),
  done_reason: z.string().optional(),
  message: z.object({ content: z.string() }),
});

export function localModelOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]', 'ollama', 'host.docker.internal'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error('Use a local HTTP model origin without credentials, paths or query parameters');
  }
  return url.origin;
}

export class OllamaRerankClient implements StructuredRerankClient {
  private readonly endpoint: string;

  constructor(
    origin: string,
    private readonly timeoutMs = 120_000,
    private readonly request: typeof fetch = fetch,
  ) {
    this.endpoint = `${localModelOrigin(origin)}/api/chat`;
  }

  async assess(input: Parameters<StructuredRerankClient['assess']>[0]) {
    const requiredContext =
      Buffer.byteLength(input.system + input.prompt + JSON.stringify(input.schema), 'utf8') + 1_536;
    if (requiredContext > 16_384) {
      throw new Error('Local model context budget exceeded; deterministic scoring retained');
    }
    const contextSize = Math.max(4_096, Math.ceil(requiredContext / 4_096) * 4_096);
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    try {
      const response = await this.request(this.endpoint, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: input.model,
          stream: false,
          think: false,
          format: input.schema,
          messages: [
            { role: 'system', content: input.system },
            { role: 'user', content: input.prompt },
          ],
          options: { temperature: 0, num_ctx: contextSize, num_predict: 1_024, num_thread: 2 },
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Local model returned HTTP ${response.status}`);
      }
      if (!response.body) throw new Error('Local model returned an empty response');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 262_144) throw new Error('Local model response exceeded the size limit');
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const parsed = replySchema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (!parsed.success) throw new Error('Local model returned an invalid response');
      if (parsed.data.done_reason === 'length') {
        return { stop_reason: 'max_tokens', parsed_output: null };
      }
      return {
        stop_reason: 'end_turn',
        parsed_output: JSON.parse(parsed.data.message.content) as unknown,
      };
    } catch {
      if (input.signal?.aborted) throw new Error('Local model request cancelled');
      if (timeout.aborted) throw new Error('Local model request timed out');
      throw new Error('Local model unavailable or returned an invalid response');
    }
  }
}
