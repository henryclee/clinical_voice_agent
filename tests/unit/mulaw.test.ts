/**
 * μ-law (G.711) codec tests.
 *
 * This codec is the wire format for Twilio Media Streams, so a wrong table silently
 * corrupts audio in a way that is invisible in text mode. The vectors below are the
 * canonical ITU-T G.711 values, not values read back out of this implementation:
 * 0xff -> 0 (silence), 0xf0 -> 120, 0x80 -> +32124, 0x00 -> -32124.
 */
import { describe, expect, it } from 'vitest';

import {
  decodeMediaPayload,
  encodeMediaPayload,
  linearToUlaw,
  pcm16ToUlaw,
  silenceBytes,
  ulawToLinear,
  ulawToPcm16,
} from '../../src/transport/mulaw.js';

/** Half a quantisation step at the amplitude of `sample` (μ-law step = 2^(e+3)). */
function halfStepBound(sample: number): number {
  const magnitude = Math.min(Math.abs(sample), 32635) + 0x84;
  let bit = 0;
  while ((magnitude >> (bit + 1)) !== 0) bit += 1;
  const exponent = Math.max(0, bit - 7);
  return 1 << (exponent + 2);
}

describe('linearToUlaw / ulawToLinear (ITU-T G.711)', () => {
  it('matches canonical decode vectors', () => {
    expect(ulawToLinear(0xff)).toBe(0); // positive silence
    expect(ulawToLinear(0x7f)).toBe(0); // negative silence
    expect(ulawToLinear(0xf8)).toBe(56); // exponent 0, mantissa 7
    expect(ulawToLinear(0xfe)).toBe(8); // exponent 0, mantissa 1
    expect(ulawToLinear(0xf0)).toBe(120);
    expect(ulawToLinear(0x80)).toBe(32124); // max positive
    expect(ulawToLinear(0x00)).toBe(-32124); // max negative
  });

  it('encodes the canonical anchors', () => {
    expect(linearToUlaw(0)).toBe(0xff);
    expect(linearToUlaw(64)).toBe(0xf7);
    expect(linearToUlaw(120)).toBe(0xf0);
    expect(linearToUlaw(32635)).toBe(0x80);
    expect(linearToUlaw(-32635)).toBe(0x00);
  });

  it('clips out-of-range input instead of overflowing', () => {
    expect(linearToUlaw(32767)).toBe(0x80);
    expect(linearToUlaw(-32768)).toBe(0x00);
    expect(ulawToLinear(0)).toBe(-32124);
  });

  it('keeps the sign relation enc(-x) === enc(x) ^ 0x80', () => {
    for (const x of [1, 8, 64, 100, 1000, 4095, 8192, 20000, 32635]) {
      expect(linearToUlaw(-x)).toBe((linearToUlaw(x) ^ 0x80) & 0xff);
    }
  });

  it('round-trips every 16-bit sample within half a quantisation step', () => {
    // G.711 μ-law clips at +/-32635, so samples beyond that are compared to the clip.
    const CLIP = 32635;
    let worstError = 0;
    let worstSample = 0;
    for (let sample = -32768; sample <= 32767; sample += 1) {
      const restored = ulawToLinear(linearToUlaw(sample));
      const target = Math.max(-CLIP, Math.min(CLIP, sample));
      const error = Math.abs(restored - target);
      const bound = halfStepBound(sample);
      expect(
        error,
        `sample ${sample} round-tripped to ${restored} (error ${error} > bound ${bound})`,
      ).toBeLessThanOrEqual(bound);
      if (error > worstError) {
        worstError = error;
        worstSample = sample;
      }
    }
    // Top segment (e=7) has a step of 1024, so half a step is 512.
    expect(worstError).toBeLessThanOrEqual(512);
    expect(Math.abs(worstSample)).toBeGreaterThan(16000);
  });

  it('round-trips the amplitudes a phone call actually carries', () => {
    for (const sample of [0, 1, -1, 17, -17, 63, -64, 500, -501, 1000, -1000, 3300, -3301, 12000, -12001, 30000, -30001]) {
      const restored = ulawToLinear(linearToUlaw(sample));
      expect(Math.abs(restored - sample)).toBeLessThanOrEqual(Math.max(4, halfStepBound(sample)));
      if (Math.abs(sample) >= 16) {
        // Sign must survive anything above the smallest quantisation interval.
        expect(Math.sign(restored)).toBe(Math.sign(sample));
      }
    }
  });

  it('produces the standard 128 distinct magnitudes over the full code space', () => {
    const magnitudes = new Set<number>();
    for (let code = 0; code <= 0xff; code += 1) magnitudes.add(Math.abs(ulawToLinear(code)));
    expect(magnitudes.size).toBe(128);
    expect(magnitudes.has(0)).toBe(true);
    expect(magnitudes.has(32124)).toBe(true);
  });

  it('decodes monotonically within each half of the code space', () => {
    for (let code = 0x80; code < 0xff; code += 1) {
      expect(ulawToLinear(code)).toBeGreaterThanOrEqual(ulawToLinear(code + 1));
    }
    for (let code = 0x00; code < 0x7f; code += 1) {
      expect(ulawToLinear(code)).toBeLessThanOrEqual(ulawToLinear(code + 1));
    }
  });

  it('encodes monotonically in magnitude', () => {
    let previousCode = 0xff;
    for (const magnitude of [0, 2, 8, 40, 128, 700, 4000, 16000, 32124, 32635]) {
      const code = linearToUlaw(magnitude);
      expect(code).toBeLessThanOrEqual(previousCode);
      previousCode = code;
    }
  });
});

describe('buffer helpers', () => {
  it('round-trips a buffer through μ-law and back to PCM16', () => {
    const pcm = Int16Array.from([0, 64, -64, 1000, -1000, 12000, -12000, 32635, -32635]);
    const encoded = pcm16ToUlaw(pcm);
    expect(encoded.length).toBe(pcm.length);
    const restored = ulawToPcm16(encoded);
    expect(restored.length).toBe(pcm.length);
    for (let i = 0; i < pcm.length; i += 1) {
      expect(Math.abs(restored[i]! - pcm[i]!)).toBeLessThanOrEqual(Math.max(4, halfStepBound(pcm[i]!)));
    }
  });

  it('accepts a little-endian PCM buffer', () => {
    const buffer = Buffer.alloc(4);
    buffer.writeInt16LE(0, 0);
    buffer.writeInt16LE(64, 2);
    expect(Array.from(pcm16ToUlaw(buffer))).toEqual([0xff, 0xf7]);
  });

  it('base64-encodes media payloads and back', () => {
    const bytes = Buffer.from([0xff, 0x7f, 0x80, 0x00]);
    const payload = encodeMediaPayload(bytes);
    expect(payload).toBe('/3+AAA==');
    expect(Array.from(decodeMediaPayload(payload))).toEqual([0xff, 0x7f, 0x80, 0x00]);
  });

  it('fills silence with the μ-law zero code', () => {
    const silence = silenceBytes(4);
    expect(Array.from(silence)).toEqual([0xff, 0xff, 0xff, 0xff]);
    expect(Array.from(ulawToPcm16(silence))).toEqual([0, 0, 0, 0]);
  });
});
