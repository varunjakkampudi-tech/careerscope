import { describe, expect, it, vi } from 'vitest';
import { localModelOrigin, OllamaRerankClient } from './ollamaRerank.js';
import { parseEnv } from '../env.js';

const input = {
  model: 'qwen2.5:1.5b-instruct-q4_K_M',
  system: 'Only use supplied facts.',
  prompt: 'Synthetic posting',
  schema: { type: 'object' },
};

describe('local model transport', () => {
  it('enables local ranking without paid credentials and preserves explicit provider validation', () => {
    expect(parseEnv({ ENABLE_LLM_RERANK: 'true', LLM_PROVIDER: 'ollama' }).LLM_PROVIDER).toBe(
      'ollama',
    );
    expect(() => parseEnv({ ENABLE_LLM_RERANK: 'true' })).toThrow('ANTHROPIC_API_KEY');
    expect(() => parseEnv({ LLM_PROVIDER: 'unknown' })).toThrow('LLM_PROVIDER');
    expect(() => parseEnv({ OLLAMA_ORIGIN: 'http://169.254.169.254' })).toThrow('OLLAMA_ORIGIN');
  });

  it('uses schema-constrained local inference without thinking or redirects', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        done: true,
        done_reason: 'stop',
        message: { content: '{"assessments":[]}' },
      }),
    );
    const client = new OllamaRerankClient('http://ollama:11434', 1000, request);
    expect(await client.assess(input)).toEqual({
      stop_reason: 'end_turn',
      parsed_output: { assessments: [] },
    });
    const [url, options] = request.mock.calls[0]!;
    expect(url).toBe('http://ollama:11434/api/chat');
    expect(options?.redirect).toBe('error');
    expect(JSON.parse(String(options?.body))).toMatchObject({
      model: input.model,
      stream: false,
      think: false,
      format: input.schema,
      options: { num_ctx: 4096, num_thread: 2 },
    });
  });

  it('rejects oversized context before sending private text rather than silently truncating', async () => {
    const request = vi.fn<typeof fetch>();
    const client = new OllamaRerankClient('http://ollama:11434', 1000, request);
    await expect(client.assess({ ...input, prompt: 'x'.repeat(16_384) })).rejects.toThrow(
      'context budget exceeded',
    );
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    'https://api.example.com',
    'http://169.254.169.254',
    'http://ollama.attacker.test',
    'http://user:password@localhost:11434',
    'http://localhost:11434/path',
    'http://localhost:11434?token=secret',
  ])('rejects nonlocal or credential-bearing endpoints: %s', (origin) => {
    expect(() => localModelOrigin(origin)).toThrow();
  });

  it.each([
    Response.json({ error: 'private source text' }, { status: 500 }),
    Response.json({ done: false, message: { content: '{}' } }),
    Response.json({ done: true, message: { content: 'private invalid output' } }),
    new Response('private invalid response'),
    new Response('x'.repeat(262_145)),
  ])(
    'rejects failed, incomplete, malformed and oversized responses without exposing content',
    async (response) => {
      const request = vi.fn<typeof fetch>().mockResolvedValue(response);
      await expect(
        new OllamaRerankClient('http://localhost:11434', 1000, request).assess(input),
      ).rejects.toThrow('Local model unavailable or returned an invalid response');
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it('reports truncated generations for deterministic fallback', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        done: true,
        done_reason: 'length',
        message: { content: '{' },
      }),
    );
    expect(
      await new OllamaRerankClient('http://localhost:11434', 1000, request).assess(input),
    ).toEqual({ stop_reason: 'max_tokens', parsed_output: null });
  });

  it('bounds requests and propagates caller cancellation', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
      const signal = options!.signal!;
      signal.throwIfAborted();
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const client = new OllamaRerankClient('http://localhost:11434', 10, request);
    await expect(client.assess(input)).rejects.toThrow('timed out');
    await expect(client.assess({ ...input, signal: AbortSignal.abort() })).rejects.toThrow(
      'cancelled',
    );
  });
});
