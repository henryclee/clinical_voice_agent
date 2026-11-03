import type { Server } from 'node:http';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { AppDeps } from './deps.js';
import { percentile, type LatencySample } from '../transport/AudioTransport.js';
import { TwilioTransport } from '../transport/TwilioTransport.js';
import { DeepgramStream, type SttClient } from '../stt/deepgramStream.js';
import { ElevenLabsStreamTts } from '../tts/elevenlabsStream.js';
import { DeepgramAuraTts } from '../tts/deepgramAuraStream.js';
import type { TtsClient } from '../tts/types.js';

/**
 * Twilio Media Streams endpoint (`/media`) — requires P2 credentials: DEEPGRAM_API_KEY
 * for STT, and ELEVENLABS_API_KEY (+ VOICE_ID) or Deepgram Aura for TTS. Without them
 * the socket closes with an explicit reason instead of silently doing nothing.
 *
 * The browser demo page uses `/ws/call?callId=…` (TextTransport) instead: no vendor keys,
 * works over plain localhost.
 */

export function buildStt(deps: AppDeps): SttClient | null {
  if (!deps.env.deepgramApiKey) return null;
  return new DeepgramStream({ apiKey: deps.env.deepgramApiKey, logger: deps.logger });
}

export function buildTts(deps: AppDeps): TtsClient | null {
  const eleven = deps.env.elevenlabs;
  if (eleven) {
    return new ElevenLabsStreamTts({ apiKey: eleven.apiKey, voiceId: eleven.voiceId, logger: deps.logger });
  }
  if (deps.env.deepgramApiKey) return new DeepgramAuraTts({ apiKey: deps.env.deepgramApiKey, logger: deps.logger });
  return null;
}

/** Per-call latency samples; p50/p95 for the demo table. */
const latencyByCall = new Map<string, LatencySample[]>();

export function voiceLatency(callId?: string): { callId: string; p50Ms: number | null; p95Ms: number | null; mode: string }[] {
  const entries = callId ? ([[callId, latencyByCall.get(callId) ?? []]] as const) : [...latencyByCall.entries()];
  return entries.map(([id, samples]) => ({
    callId: id,
    p50Ms: percentile(samples.map((s) => s.ms), 50),
    p95Ms: percentile(samples.map((s) => s.ms), 95),
    mode: samples[0]?.mode ?? 'live-audio',
  }));
}

export function attachMediaStream(server: Server, deps: AppDeps): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/media' });

  wss.on('connection', (socket: WebSocket, request) => {
    const url = new URL(request.url ?? '/media', 'http://localhost');
    const twilioCallSid = url.searchParams.get('callSid');
    const stt = buildStt(deps);
    const tts = buildTts(deps);

    if (!stt || !tts || !twilioCallSid) {
      deps.logger.error(
        'media stream rejected — need DEEPGRAM_API_KEY, TTS credentials and ?callSid= (see README P2 section)',
      );
      socket.close(1011, 'voice providers or callSid missing');
      void stt?.close();
      return;
    }

    const transport = new TwilioTransport({
      socket: socket as never,
      callSid: twilioCallSid,
      stt,
      tts,
      logger: deps.logger,
    });
    const samples: LatencySample[] = [];
    latencyByCall.set(twilioCallSid, samples);
    let turnIndex = 0;
    let ourCallId: string | null = null;

    void (async () => {
      try {
        await stt.connect();
        const call = await deps.repos.calls.getByTwilioCallSid(twilioCallSid);
        if (!call) {
          deps.logger.error({ twilioCallSid }, 'media stream for unknown callSid (start the call via /calls/outbound)');
          socket.close(1011, 'unknown callSid');
          return;
        }
        ourCallId = call.id;
      } catch (error) {
        deps.logger.error({ error: error instanceof Error ? error.message : String(error) }, 'STT connect failed');
        socket.close(1011, 'stt unavailable');
      }
    })();

    transport.onUtterance((text) => {
      void (async () => {
        if (!ourCallId) return;
        const result = await deps.orchestrator.turn(ourCallId, text).catch((error: unknown) => {
          deps.logger.error({ error: error instanceof Error ? error.message : String(error) }, 'orchestrator turn failed');
          return null;
        });
        if (!result) return;
        turnIndex += 1;
        samples.push({ turnIndex, ms: result.latencyMs, mode: 'live-audio' });
        await transport.speak(result.agentUtterance);
        if (result.callEnded) await transport.close('call ended');
      })();
    });

    socket.on('message', (raw: Buffer | string) => transport.handleRawMessage(raw));
    socket.on('close', () => {
      void transport.close('socket closed');
      deps.logger.info({ twilioCallSid, latency: voiceLatency(twilioCallSid)[0] }, 'media stream closed');
    });
    socket.on('error', (error: Error) => deps.logger.error({ twilioCallSid, error: error.message }, 'media socket error'));
  });

  return wss;
}

/** Text-mode WebSocket (`/ws/call?callId=…`) used by public/index.html — no vendor keys. */
export function attachTextSocket(server: Server, deps: AppDeps): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws/call' });

  wss.on('connection', (socket: WebSocket, request) => {
    const url = new URL(request.url ?? '/ws/call', 'http://localhost');
    const callId = url.searchParams.get('callId');
    if (!callId) {
      socket.close(1011, 'missing callId');
      return;
    }
    socket.send(JSON.stringify({ type: 'ready', callId }));

    socket.on('message', (raw: Buffer | string) => {
      void (async () => {
        let parsed: { type?: string; text?: string };
        try {
          parsed = JSON.parse(raw.toString('utf8')) as { type?: string; text?: string };
        } catch {
          socket.send(JSON.stringify({ type: 'error', error: 'expected JSON {type:"text",text:"…"}' }));
          return;
        }
        if (parsed.type === 'end') {
          const summary = await deps.orchestrator
            .end(callId, 'refused')
            .catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
          socket.send(JSON.stringify({ type: 'ended', summary }));
          socket.close();
          return;
        }
        const text = (parsed.text ?? '').trim();
        if (text.length === 0) return;
        const result = await deps.orchestrator.turn(callId, text).catch(() => null);
        if (!result) {
          socket.send(JSON.stringify({ type: 'error', error: 'turn failed (call already ended?)' }));
          return;
        }
        socket.send(
          JSON.stringify({
            type: 'agent_text',
            text: result.agentUtterance,
            step: result.stepId,
            stepAdvanced: result.stepAdvanced,
            escalations: result.escalations.map((e) => `${e.ruleId}:${e.urgency}`),
            callEnded: result.callEnded,
            outcome: result.outcome,
            latencyMs: result.latencyMs,
          }),
        );
      })();
    });
  });

  return wss;
}

