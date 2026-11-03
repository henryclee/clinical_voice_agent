import type { FastifyInstance, FastifyReply } from 'fastify';
import twilio from 'twilio';
import { z } from 'zod';
import type { AppDeps } from './deps.js';
import { EnvError } from '../config/env.js';
import { DischargeParseError } from '../extraction/dischargeParser.js';
import { extractDischarge } from '../extraction/extractor.js';
import { TRANSFER_MESSAGE } from '../orchestrator/Orchestrator.js';
import { mapTwilioStatus, outcomeForAbandonedStatus, twimlAnswerWithStream, twimlWarmTransfer } from './twiml.js';

/**
 * HTTP surface. The text-mode endpoints work with zero cloud credentials (P0/P1);
 * Twilio-backed endpoints return 503 naming the exact missing variables when P2 keys are
 * absent, so nothing here fails ambiguously.
 *
 * SECURITY GAP (documented in README): `X-Twilio-Signature` validation of inbound
 * webhooks is intentionally out of scope for this prototype.
 */

const PatientBody = z.object({
  externalRef: z.string().min(1),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'dob must be yyyy-mm-dd'),
  phone: z.string().min(7),
});

const IngestBody = z.object({
  patient: PatientBody.optional(),
  patientId: z.string().min(8).optional(),
  sourceFilename: z.string().min(1).default('upload.md'),
  documentMarkdown: z.string().min(20),
});

const TurnBody = z.object({ utterance: z.string().max(1000) });
const OutboundBody = z.object({ patientId: z.string().min(8) });
const EndBody = z.object({ outcome: z.enum(['completed', 'partial', 'refused', 'escalated']).optional() });
const StatusBody = z.object({ CallSid: z.string().min(4), CallStatus: z.string().min(3) });

function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof EnvError) return reply.code(503).send({ error: error.message, missing: error.missing });
  if (error instanceof DischargeParseError) {
    return reply.code(422).send({ error: error.message, source: error.source, issues: error.issues });
  }
  if (error instanceof z.ZodError) {
    return reply
      .code(400)
      .send({ error: 'invalid request body', issues: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
  }
  return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
}

export function registerRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get('/healthz', async () => {
    await deps.ready.catch(() => undefined);
    return {
      ok: true,
      llm: deps.llm.kind,
      model: deps.env.llm.model,
      repositories: deps.repositoriesKind,
      textOnly: deps.env.textOnly,
      script: `${deps.script.script.id}@${deps.script.script.version}`,
      requiredSteps: deps.script.requiredSteps,
    };
  });

  app.post('/ingest/discharge', async (request, reply) => {
    try {
      const body = IngestBody.parse(request.body);
      let patientId = body.patientId;
      if (!patientId && body.patient) {
        const org = await deps.repos.organizations.ensureByName(deps.env.practiceName);
        const existing = await deps.repos.patients.findByExternalRef(org.id, body.patient.externalRef);
        patientId = existing?.id ?? (await deps.repos.patients.create({ orgId: org.id, ...body.patient })).id;
      }
      if (!patientId) return reply.code(400).send({ error: 'patientId or patient is required' });
      const patient = await deps.repos.patients.get(patientId);
      if (!patient) return reply.code(404).send({ error: `patient ${patientId} not found` });

      const extracted = await extractDischarge(body.documentMarkdown, {
        llm: deps.llm,
        source: body.sourceFilename,
        logger: deps.logger,
      });
      const doc = await deps.repos.dischargeDocuments.create({
        patientId,
        sourceFilename: body.sourceFilename,
        rawText: body.documentMarkdown,
        parsedJson: extracted.data,
      });
      return reply
        .code(201)
        .send({ patientId, documentId: doc.id, method: extracted.method, notes: extracted.notes, parsed: extracted.data });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/patients', async (_request, reply) => {
    try {
      const org = await deps.repos.organizations.ensureByName(deps.env.practiceName);
      const patients = await deps.repos.patients.listByOrg(org.id, 50);
      return patients.map((p) => ({
        id: p.id,
        name: `${p.firstName} ${p.lastName}`,
        dob: p.dob,
        phone: p.phone,
        ref: p.externalRef,
      }));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /** Text-mode call start (no Twilio needed) — tests, evals and the CLI demo. */
  app.post('/calls/text', async (request, reply) => {
    try {
      const body = OutboundBody.parse(request.body);
      const turn = await deps.orchestrator.start({ patientId: body.patientId, twilioCallSid: null });
      return reply.code(201).send(turn);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/calls/:id/turn', async (request, reply) => {
    try {
      const body = TurnBody.parse(request.body);
      return await deps.orchestrator.turn(request.params.id, body.utterance);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/calls/:id/end', async (request, reply) => {
    try {
      const body = EndBody.parse(request.body ?? {});
      return await deps.orchestrator.end(request.params.id, body.outcome ?? 'refused');
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/calls', async (_request, reply) => {
    try {
      const calls = await deps.repos.calls.listRecent(25);
      return calls.map((c) => ({
        id: c.id,
        patientId: c.patientId,
        twilioCallSid: c.twilioCallSid,
        status: c.status,
        outcome: c.outcome,
        startedAt: c.startedAt,
        endedAt: c.endedAt,
      }));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>('/calls/:id', async (request, reply) => {
    try {
      const call = await deps.repos.calls.get(request.params.id);
      if (!call) return reply.code(404).send({ error: 'call not found' });
      const turns = await deps.repos.callTurns.listByCall(call.id);
      return { call, turns };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>('/calls/:id/summary', async (request, reply) => {
    try {
      return await deps.orchestrator.summary(request.params.id);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/escalations/open', async (_request, reply) => {
    try {
      return await deps.repos.escalations.listOpen(50);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /** Create an outbound call through Twilio (P2). 503 names the missing variables. */
  app.post('/calls/outbound', async (request, reply) => {
    try {
      const body = OutboundBody.parse(request.body);
      const tw = deps.env.twilio;
      if (!tw) {
        return reply.code(503).send({
          error:
            'Twilio is not configured — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER and PUBLIC_HOST',
        });
      }
      const patient = await deps.repos.patients.get(body.patientId);
      if (!patient) return reply.code(404).send({ error: `patient ${body.patientId} not found` });

      const client = twilio(tw.accountSid, tw.authToken);
      const outbound = await client.calls.create({
        to: patient.phone,
        from: tw.fromNumber,
        url: `https://${tw.publicHost}/voice`,
        method: 'POST',
        statusCallback: `https://${tw.publicHost}/calls/status`,
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed', 'failed', 'busy', 'no-answer'],
      });

      const turn = await deps.orchestrator.start({ patientId: body.patientId, twilioCallSid: outbound.sid });
      return reply.code(201).send({ callId: turn.callId, twilioCallSid: outbound.sid, greeting: turn.agentUtterance });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /** Twilio voice webhook: answer and open a media stream bound to this call. */
  app.post<{ Querystring: { callId?: string } }>('/voice', async (request, reply) => {
    const tw = deps.env.twilio;
    const callSid = (request.body as { CallSid?: string } | undefined)?.CallSid ?? request.query.callId ?? null;
    if (!tw) {
      return reply
        .code(503)
        .type('application/xml')
        .send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Telephony is not configured on this server.</Say></Response>');
    }
    const streamUrl = `wss://${tw.publicHost}/media${callSid ? `?callSid=${encodeURIComponent(callSid)}` : ''}`;
    return reply.type('application/xml').send(twimlAnswerWithStream(streamUrl));
  });

  /**
   * Twilio status callback. Idempotent: re-delivering the same CallSid + status is a
   * no-op. Writes `calls.status` ONLY — except for dropped calls, where the agent never
   * got to decide and the outcome is recorded as `partial`.
   */
  app.post('/calls/status', async (request, reply) => {
    try {
      const body = StatusBody.parse(request.body);
      const status = mapTwilioStatus(body.CallStatus);
      if (!status) return reply.code(400).send({ error: `unknown CallStatus "${body.CallStatus}"` });
      const call = await deps.repos.calls.getByTwilioCallSid(body.CallSid);
      if (!call) return reply.code(404).send({ error: 'unknown CallSid', callSid: body.CallSid });
      if (call.status === status) return reply.send({ ok: true, idempotent: true, status });

      const patch: Parameters<typeof deps.repos.calls.update>[1] = { status };
      const abandoned = outcomeForAbandonedStatus(status);
      if (abandoned && !call.outcome) {
        patch.outcome = abandoned;
        patch.endedAt = new Date();
      }
      const updated = await deps.repos.calls.update(call.id, patch);
      return reply.send({ ok: true, callId: call.id, status: updated?.status ?? status, outcome: updated?.outcome ?? null });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /** Warm-transfer TwiML for an escalated call (bridges to the staff line). */
  app.get<{ Params: { id: string } }>('/calls/:id/warm-transfer-twiml', async (request, reply) => {
    const staff = deps.env.escalationStaffNumber;
    if (!staff) {
      return reply
        .code(503)
        .type('application/xml')
        .send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>No staff number configured.</Say></Response>');
    }
    const call = await deps.repos.calls.get(request.params.id);
    if (!call) return reply.code(404).send({ error: 'call not found' });
    return reply.type('application/xml').send(twimlWarmTransfer(staff, TRANSFER_MESSAGE));
  });
}


