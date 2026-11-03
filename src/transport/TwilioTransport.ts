import type { AppLogger } from '../common/logger.js';
import { noopLogger } from '../common/logger.js';
import type { SttClient } from '../stt/deepgramStream.js';
import { frameUlaw, type TtsClient } from '../tts/types.js';
import type { AudioTransport, SocketLike } from './AudioTransport.js';
import { decodeMediaPayload, encodeMediaPayload } from './mulaw.js';

/**
 * Twilio Programmatic Media Streams transport.
 *
 * Inbound events : {"event":"connected"|"start"|"media"|"mark"|"clear", ...}
 * Outbound events: {"event":"media","streamSid":…,"media":{"payload":"<b64 ulaw>"}}
 *                {"event":"clear","streamSid":…}   <- barge-in: stop playback
 *
 * Barge-in: when STT reports speech started while TTS is playing, we (a) send a `clear`
 * frame so Twilio drops queued audio and (b) abort the in-flight TTS fetch so bytes stop
 * arriving. Both are asserted in tests/unit/twilioTransport.test.ts.
 */

interface TwilioEvent {
  event?: string;
  streamSid?: string;
  sequenceNumber?: number;
  media?: { payload?: string; track?: string; timestamp?: string };
}

export interface TwilioTransportOptions {
  socket: SocketLike;
  callSid: string;
  streamSid?: string | null;
  stt: SttClient;
  tts: TtsClient;
  logger?: AppLogger;
  /** 160 bytes = 20 ms of μ-law at 8 kHz. */
  frameBytes?: number;
  pacingMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class TwilioTransport implements AudioTransport {
  readonly kind = 'twilio' as const;
  readonly callSid: string;
  streamSid: string | null;

  /** Observability for tests and demos. */
  readonly eventsSent: Record<string, unknown>[] = [];
  readonly bytesSent = { total: 0 };

  private playing = false;
  private abort: AbortController | null = null;
  private connected = false;
  private utteranceHandlers: ((text: string) => void)[] = [];
  private speechStartHandlers: (() => void)[] = [];
  private connectedHandlers: (() => void)[] = [];
  private disconnectedHandlers: ((reason?: string) => void)[] = [];
  private readonly logger: AppLogger;
  private readonly frameBytes: number;
  private readonly pacingMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: TwilioTransportOptions) {
    this.callSid = options.callSid;
    this.streamSid = options.streamSid ?? null;
    this.logger = options.logger ?? noopLogger;
    this.frameBytes = options.frameBytes ?? 160;
    this.pacingMs = options.pacingMs ?? 20;
    this.sleep = options.sleep ?? defaultSleep;
    options.stt.onTranscript((transcript) => {
      if (transcript.speechStarted && this.playing) void this.bargeIn();
      if (transcript.speechStarted) {
        for (const handler of this.speechStartHandlers) handler();
      }
      if (transcript.isFinal && transcript.transcript.trim().length > 0) {
        for (const handler of this.utteranceHandlers) handler(transcript.transcript.trim());
      }
    });
  }

  onUtterance(handler: (text: string) => void): void {
    this.utteranceHandlers.push(handler);
  }

  onSpeechStart(handler: () => void): void {
    this.speechStartHandlers.push(handler);
  }

  onConnected(handler: () => void): void {
    this.connectedHandlers.push(handler);
  }

  onDisconnected(handler: (reason?: string) => void): void {
    this.disconnectedHandlers.push(handler);
  }

  /** Entry point for raw frames arriving on the Twilio media WebSocket. */
  handleRawMessage(raw: string | Buffer): void {
    let event: TwilioEvent;
    try {
      event = JSON.parse(raw.toString('utf8')) as TwilioEvent;
    } catch {
      this.logger.debug({ raw: raw.toString('utf8').slice(0, 120) }, 'twilio: non-JSON frame ignored');
      return;
    }

    switch (event.event) {
      case 'connected':
      case 'start': {
        this.streamSid = event.streamSid ?? this.streamSid;
        if (!this.connected) {
          this.connected = true;
          for (const handler of this.connectedHandlers) handler();
        }
        this.sendEvent({ event: 'mark', streamSid: this.streamSid, name: 'turn-start' });
        break;
      }
      case 'media': {
        const payload = event.media?.payload;
        if (payload) this.options.stt.sendAudio(decodeMediaPayload(payload));
        break;
      }
      case 'clear':
        this.playing = false;
        break;
      case 'mark':
      default:
        break;
    }
  }

  private sendEvent(event: Record<string, unknown>): void {
    this.eventsSent.push(event);
    const ready = this.options.socket.readyState;
    if (ready !== undefined && ready !== 1) return;
    this.options.socket.send(JSON.stringify(event));
  }

  /** Interrupt playback: ask Twilio to drop queued audio and abort the TTS request. */
  private async bargeIn(): Promise<void> {
    if (!this.playing) return;
    this.sendEvent({ event: 'clear', streamSid: this.streamSid });
    this.playing = false;
    this.abort?.abort();
    this.logger.debug({ callSid: this.callSid }, 'barge-in: cleared playback, aborted TTS');
  }

  async stopSpeaking(): Promise<void> {
    await this.bargeIn();
  }

  async speak(text: string): Promise<void> {
    const utterance = text.trim();
    if (utterance.length === 0) return;
    this.playing = true;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    try {
      for await (const chunk of this.options.tts.stream(utterance, { signal })) {
        if (!this.playing) break;
        for (const frame of frameUlaw(chunk, this.frameBytes)) {
          if (!this.playing) break;
          this.bytesSent.total += frame.length;
          this.sendEvent({
            event: 'media',
            streamSid: this.streamSid,
            media: { payload: encodeMediaPayload(frame), track: 'inbound' },
          });
          if (this.pacingMs > 0) await this.sleep(this.pacingMs);
        }
      }
    } catch (error) {
      if (!signal.aborted) {
        this.logger.error(
          { callSid: this.callSid, error: error instanceof Error ? error.message : String(error) },
          'TTS stream failed',
        );
      }
    } finally {
      this.playing = false;
      this.abort = null;
    }
  }

  async close(reason?: string): Promise<void> {
    this.abort?.abort();
    this.playing = false;
    await this.options.stt.close();
    this.options.socket.close();
    for (const handler of this.disconnectedHandlers) handler(reason);
  }
}

