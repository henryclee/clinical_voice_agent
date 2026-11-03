import type { AppLogger } from '../common/logger.js';
import { noopLogger } from '../common/logger.js';
import type { TtsClient } from './types.js';

/**
 * Deepgram Aura TTS fallback (used when no ElevenLabs key is configured).
 * `POST /v1/speak?model=...&encoding=mulaw&sample_rate=8000` returns a raw μ-law stream.
 */
export interface DeepgramAuraOptions {
  apiKey: string;
  voice?: string;
  logger?: AppLogger;
  fetchImpl?: typeof fetch;
}

export class DeepgramAuraTts implements TtsClient {
  readonly name = 'deepgram-aura';
  private readonly apiKey: string;
  private readonly voice: string;
  private readonly logger: AppLogger;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DeepgramAuraOptions) {
    this.apiKey = options.apiKey;
    this.voice = options.voice ?? 'aura-2-thunder-en';
    this.logger = options.logger ?? noopLogger;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async *stream(text: string, options?: { signal?: AbortSignal }): AsyncIterable<Buffer> {
    const params = new URLSearchParams({ model: this.voice, encoding: 'mulaw', sample_rate: '8000' });
    const response = await this.fetchImpl(`https://api.deepgram.com/v1/speak?${params.toString()}`, {
      method: 'POST',
      headers: { Authorization: `Token ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: options?.signal,
    });
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      this.logger.error({ status: response.status, detail: detail.slice(0, 300) }, 'Deepgram Aura TTS failed');
      throw new Error(`Deepgram Aura TTS failed (${response.status}): ${detail.slice(0, 200)}`);
    }
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) yield Buffer.from(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
}
