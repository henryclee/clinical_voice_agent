import { WebSocket } from 'ws';
import type { AppLogger } from '../common/logger.js';
import { noopLogger } from '../common/logger.js';

/**
 * Deepgram streaming STT (nova-2-phonecall, mulaw 8kHz) — the phone-audio model.
 * The WebSocket is injected in tests so the parse/dispatch logic is covered without a
 * network or an API key.
 */

export interface SttTranscript {
  transcript: string;
  isFinal: boolean;
  speechStarted: boolean;
  speechFinal: boolean;
}

export interface SttClient {
  connect(): Promise<void>;
  sendAudio(chunk: Buffer): void;
  close(): Promise<void>;
  onTranscript(handler: (transcript: SttTranscript) => void): void;
}

/** Duck-typed WebSocket connection (real `ws` in production, fake in tests). */
export interface WsConnection {
  send(data: string | Buffer): void;
  close(): void;
  on(event: 'open' | 'message' | 'error' | 'close', listener: (arg: unknown) => void): void;
  readyState?: number;
}

export type WsFactory = (url: string) => WsConnection;

export interface DeepgramOptions {
  apiKey: string;
  model?: string;
  endpointingMs?: number;
  utteranceEndMs?: number;
  logger?: AppLogger;
  wsFactory?: WsFactory;
}

const BASE = 'wss://api.deepgram.com/v1/listen';

export class DeepgramStream implements SttClient {
  private readonly url: string;
  private readonly logger: AppLogger;
  private readonly wsFactory: WsFactory;
  private socket: WsConnection | null = null;
  private handlers: ((transcript: SttTranscript) => void)[] = [];

  constructor(options: DeepgramOptions) {
    this.logger = options.logger ?? noopLogger;
    const params = new URLSearchParams({
      model: options.model ?? 'nova-2-phonecall',
      encoding: 'mulaw',
      sample_rate: '8000',
      channels: '1',
      interim_results: 'true',
      endpointing: String(options.endpointingMs ?? 300),
      utterance_end_ms: String(options.utteranceEndMs ?? 1000),
    });
    this.url = `${BASE}?${params.toString()}`;
    this.wsFactory =
      options.wsFactory ??
      ((url) => new WebSocket(url, { headers: { Authorization: `Token ${options.apiKey}` } }) as unknown as WsConnection);
  }

  onTranscript(handler: (transcript: SttTranscript) => void): void {
    this.handlers.push(handler);
  }

  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = this.wsFactory(this.url);
      this.socket = socket;
      socket.on('open', () => resolve());
      socket.on('error', (error) => reject(error instanceof Error ? error : new Error(String(error))));
      socket.on('close', () => {
        this.socket = null;
      });
      socket.on('message', (raw) => this.handleMessage(raw));
    });
  }

  private handleMessage(raw: unknown): void {
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
    let message: DeepgramMessage;
    try {
      message = JSON.parse(text) as DeepgramMessage;
    } catch {
      this.logger.debug({ raw: text.slice(0, 200) }, 'deepgram: non-JSON frame ignored');
      return;
    }
    const channel = message.channel;
    const alternative = channel?.alternatives?.[0];
    const transcript = alternative?.transcript ?? '';
    if (!transcript && !message.speech_started && !message.speech_final && !channel?.is_final) return;
    const transcript_ : SttTranscript = {
      transcript,
      isFinal: channel?.is_final === true || message.message_type === 'UtteranceEnd',
      speechStarted: message.speech_started === true || alternative?.speech_started === true,
      speechFinal: message.speech_final === true || message.message_type === 'UtteranceEnd',
    };
    for (const handler of this.handlers) handler(transcript_);
  }

  sendAudio(chunk: Buffer): void {
    if (!this.socket) {
      this.logger.warn('deepgram: sendAudio before connect() — frame dropped');
      return;
    }
    this.socket.send(chunk);
  }

  async close(): Promise<void> {
    this.socket?.close();
    this.socket = null;
  }
}

interface DeepgramMessage {
  message_type?: string;
  speech_started?: boolean;
  speech_final?: boolean;
  channel?: {
    is_final?: boolean;
    alternatives?: Array<{ transcript?: string; speech_started?: boolean }>;
  };
}

/** Deterministic STT stand-in for tests, evals and keyless demos. */
export class ScriptedStt implements SttClient {
  private handlers: ((transcript: SttTranscript) => void)[] = [];
  readonly audioBytes = { total: 0 };

  constructor(private readonly utterances: readonly string[] = []) {}

  onTranscript(handler: (transcript: SttTranscript) => void): void {
    this.handlers.push(handler);
  }

  async connect(): Promise<void> {
    // no-op
  }

  sendAudio(chunk: Buffer): void {
    this.audioBytes.total += chunk.length;
  }

  async close(): Promise<void> {
    // no-op
  }

  /** Emit speech-start + a final transcript for one utterance. */
  emit(text: string): void {
    for (const handler of this.handlers) {
      handler({ transcript: '', isFinal: false, speechStarted: true, speechFinal: false });
      handler({ transcript: text, isFinal: true, speechStarted: false, speechFinal: true });
    }
  }
}
