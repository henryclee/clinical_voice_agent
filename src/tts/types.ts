/** Shared streaming-TTS contract: yields μ-law 8kHz chunks (Twilio-ready). */
export interface TtsClient {
  readonly name: string;
  stream(text: string, options?: { signal?: AbortSignal }): AsyncIterable<Buffer>;
}

/** Chunk raw μ-law bytes into ~20ms frames (160 bytes at 8kHz) for Twilio media events. */
export function frameUlaw(bytes: Buffer, frameBytes = 160): Buffer[] {
  const frames: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += frameBytes) {
    frames.push(bytes.subarray(offset, Math.min(bytes.length, offset + frameBytes)));
  }
  return frames;
}
