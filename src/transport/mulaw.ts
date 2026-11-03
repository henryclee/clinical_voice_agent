/**
 * μ-law (G.711) codec — the encoding Twilio Media Streams and telephony STT/TTS use.
 * Pure functions, no dependencies, fully unit-testable (8kHz mono).
 *
 * Encode follows ITU-T G.711 (bias 0x84, clip 32635, sign + 3-bit exponent + 4-bit mantissa).
 * Decode inverts that construction: the exponent selects a segment whose base is 2^(e+7) and
 * whose mantissa step is 2^(e+3); taking the interval midpoint keeps round-trip error inside
 * half a quantisation step at every amplitude.
 */

const BIAS = 0x84;
const CLIP = 32635;

export function linearToUlaw(sample: number): number {
  let pcm = Math.max(-32768, Math.min(32767, Math.round(sample)));
  const sign = pcm < 0 ? 0x80 : 0x00;
  if (pcm < 0) pcm = -pcm;
  if (pcm > CLIP) pcm = CLIP;
  pcm += BIAS;

  let exponent = 7;
  for (let mask = 0x4000; exponent >= 0; exponent -= 1, mask >>= 1) {
    if ((pcm & mask) !== 0) break;
  }
  if (exponent < 0) exponent = 0;
  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export function ulawToLinear(byte: number): number {
  const complemented = ~byte & 0xff;
  const sign = complemented & 0x80;
  const exponent = (complemented >> 4) & 0x07;
  const mantissa = complemented & 0x0f;
  const midpoint = (1 << (exponent + 7)) + (mantissa << (exponent + 3)) + (1 << (exponent + 2)) - BIAS;
  const sample = sign !== 0 ? -midpoint : midpoint;
  // μ-law has two zeros; collapse -0 so callers never have to think about it.
  return Math.max(-32768, Math.min(32767, sample === 0 ? 0 : sample));
}

/** 16-bit little-endian PCM samples -> μ-law buffer. */
export function pcm16ToUlaw(pcm: Int16Array | Buffer): Buffer {
  const samples = Buffer.isBuffer(pcm) ? new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2) : pcm;
  const out = Buffer.alloc(samples.length);
  for (let i = 0; i < samples.length; i += 1) out[i] = linearToUlaw(samples[i] ?? 0);
  return out;
}

/** μ-law buffer -> 16-bit little-endian PCM samples. */
export function ulawToPcm16(ulaw: Buffer): Int16Array {
  const out = new Int16Array(ulaw.length);
  for (let i = 0; i < ulaw.length; i += 1) out[i] = ulawToLinear(ulaw[i] ?? 0);
  return out;
}

/** Twilio media payloads are base64 μ-law. */
export function decodeMediaPayload(payload: string): Buffer {
  return Buffer.from(payload, 'base64');
}

export function encodeMediaPayload(ulaw: Buffer): string {
  return ulaw.toString('base64');
}

/** ~1 second of silence in μ-law (0xff is the μ-law zero-ish code). */
export function silenceBytes(byteCount: number): Buffer {
  return Buffer.alloc(byteCount, 0xff);
}
