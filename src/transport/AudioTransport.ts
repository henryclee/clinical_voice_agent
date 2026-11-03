/**
 * Transport abstraction. The orchestrator never learns whether it is talking to a phone
 * line, a browser socket, or an array of strings in a test — that is the whole point of
 * this interface (PLAN Module B acceptance: the orchestrator must not import from
 * `stt/`, `tts/`, or `server/`).
 */

export interface AudioTransport {
  readonly kind: 'text' | 'twilio' | 'browser';

  /** Finalised patient utterance (post-STS endpointing, or one CLI line in text mode). */
  onUtterance(handler: (text: string) => void): void;
  /** Inbound speech started — used to drive barge-in / TTS cancellation. */
  onSpeechStart(handler: () => void): void;
  onConnected(handler: () => void): void;
  onDisconnected(handler: (reason?: string) => void): void;

  /** Speak to the patient. Implementations stream when they can. */
  speak(text: string): Promise<void>;
  /** Stop any in-flight playback (barge-in). Must be safe to call when idle. */
  stopSpeaking(): Promise<void>;
  close(reason?: string): Promise<void>;
}

/** Minimal duck-typed WebSocket so transports are testable without a server. */
export interface SocketLike {
  send(data: string | Buffer): void;
  close(): void;
  readyState?: number;
}

export interface LatencySample {
  turnIndex: number;
  /** Wall-clock ms from utterance received to first audio/text out. */
  ms: number;
  /** Text-mode replays measure LLM time only; label them honestly. */
  mode: 'live-audio' | 'text';
}

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? null;
}
