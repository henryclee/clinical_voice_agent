import type { AppLogger } from '../common/logger.js';
import { noopLogger } from '../common/logger.js';
import type { TtsClient } from './types.js';

/**
 * ElevenLabs streaming TTS (`ulaw_8000` on `eleven_turbo_v2_5`) — the response is already
 * μ-law 8kHz, so chunks go straight into Twilio media events.
 */
export interface ElevenLabsOptions {
  apiKey: string;
  voiceId: string;
  modelId?: string;
  logger?: AppLogger;
  fetchImpl?: typeof fetch;
}

export class ElevenLabsStreamTts implements TtsClient {
  readonly name = 'elevenlabs';
  private readonly apiKey: string;
  private readonly voiceId: string;
  private readonly modelId: string;
  private readonly logger: AppLogger;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ElevenLabsOptions) {
    this.apiKey = options.apiKey;
    this.voiceId = options.voiceId;
    this.modelId = options.modelId ?? 'eleven_turbo_v2_5';
    this.logger = options.logger ?? noopLogger;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async *stream(text: string, options?: { signal?: AbortSignal }): AsyncIterable<Buffer> {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}/stream?output_format=ulaw_8000`;
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'xi-api-key': this.apiKey, 'Content-Type': 'application/json', Accept: 'audio/ulaw' },
      body: JSON.stringify({ text, model_id: this.modelId, voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
      signal: options?.signal,
    });
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      this.logger.error({ status: response.status, detail: detail.slice(0, 300) }, 'ElevenLabs TTS failed');
      throw new Error(`ElevenLabs TTS failed (${response.status}): ${detail.slice(0, 200)}`);
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
