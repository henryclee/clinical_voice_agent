import type { z } from 'zod';
import type { ClinicalFields } from '../extraction/clinicalFields.js';
import { parseClinicalFields } from '../extraction/clinicalFields.js';
import type { AppLogger } from '../common/logger.js';
import type { CallOutcome } from '../db/schema.js';
import type { Repositories } from '../db/repositories/types.js';
import { TOOL_ARGUMENT_SCHEMAS, type ToolArgsMap, type ToolName } from './definitions.js';
import { validateToolArgs } from './coerce.js';

/**
 * Tool execution. Arguments arrive already parsed but are re-validated here — the model
 * is never trusted with the write path.
 *
 * IMPORTANT: `flag_red_flag` is a PROPOSAL only. It never creates an escalation row;
 * the deterministic escalation engine (src/escalation/engine.ts) is the sole authority
 * for whether a human gets paged ("model proposes, rules decide").
 */

export interface ExtractionDelta {
  field: string;
  value: unknown;
  confidence: number | null;
}

export interface ToolContext {
  callId: string;
  practiceName: string;
  logger: AppLogger;
  repos?: Repositories;
  now?: () => Date;
}

export interface ToolResult {
  tool: ToolName;
  ok: boolean;
  /** Canonical field deltas to merge into call state. */
  fields: Partial<ClinicalFields>;
  extractions: ExtractionDelta[];
  nextSteps: string[];
  endCall?: CallOutcome;
  followup?: { scheduledFor: Date; reason: string };
  error?: string;
  /** Structured acknowledgement returned to the model as a `role: 'tool'` message. */
  toolResponse: Record<string, unknown>;
}

/** `record_vital.name` -> canonical ClinicalFields name (the alias seam). */
export const VITAL_NAME_CANONICAL: Record<string, keyof ClinicalFields | null> = {
  temperature_f: 'fever_f',
  heart_rate: null,
  spo2: null,
};

function severityToBreath(severity: number): 'mild' | 'moderate' | 'severe' {
  if (severity >= 8) return 'severe';
  if (severity >= 4) return 'moderate';
  return 'mild';
}

const ISO_DATEISH = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function applySymptom(args: z.output<typeof TOOL_ARGUMENT_SCHEMAS.record_symptom>): {
  fields: Partial<ClinicalFields>;
  nextSteps: string[];
  extraction: ExtractionDelta;
} {
  const extraction: ExtractionDelta = {
    field: `symptom:${args.symptom}`,
    value: { severity: args.severity, onset: args.onset, present: args.presence, notes: args.notes ?? null },
    confidence: null,
  };
  if (!args.presence) {
    // Explicit denial: record the negative, which is what escalation rules need.
    switch (args.symptom) {
      case 'shortness_of_breath':
        return { fields: { shortness_of_breath: 'none' }, nextSteps: [], extraction };
      case 'chest_pain':
        return { fields: { chest_pain: false }, nextSteps: [], extraction };
      case 'wound':
        return { fields: { wound_concern: false }, nextSteps: [], extraction };
      case 'pain':
        return { fields: { pain_score: 0 }, nextSteps: [], extraction };
      default:
        return { fields: {}, nextSteps: [], extraction };
    }
  }
  switch (args.symptom) {
    case 'pain':
      return { fields: { pain_score: args.severity }, nextSteps: [], extraction };
    case 'shortness_of_breath':
      return { fields: { shortness_of_breath: severityToBreath(args.severity) }, nextSteps: [], extraction };
    case 'chest_pain':
      return { fields: { chest_pain: true }, nextSteps: [], extraction };
    case 'wound':
      return { fields: { wound_concern: true }, nextSteps: [], extraction };
    default:
      // fever without a thermometer reading, plus non-canonical symptoms, stay as
      // narrative next-steps items rather than inventing canonical values.
      return {
        fields: {},
        nextSteps: [`${args.symptom} reported (severity ${args.severity}, onset ${args.onset})`],
        extraction,
      };
  }
}

/** Narrow the validated argument union to one tool's shape (the switch discriminates). */
function typed<T extends ToolName>(tool: T, args: ToolArgsMap[ToolName]): ToolArgsMap[T] {
  return args as ToolArgsMap[T];
}

/** Execute one tool call. Never throws: failures come back as `ok: false` + error. */
export async function handleToolCall(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
  const fail = (tool: ToolName, error: string): ToolResult => ({
    tool,
    ok: false,
    fields: {},
    extractions: [],
    nextSteps: [],
    error,
    toolResponse: { status: 'error', tool, error },
  });

  if (!(name in TOOL_ARGUMENT_SCHEMAS)) {
    ctx.logger.warn({ tool: name }, 'tool call rejected: unknown tool');
    return fail('record_symptom', `unknown tool "${name}"`);
  }
  const tool = name as ToolName;
  // The union of all tool schemas defeats generic inference; validate generically here
  // and narrow per-case with `typed()` against ToolArgsMap.
  const parsed = validateToolArgs(TOOL_ARGUMENT_SCHEMAS[tool] as z.ZodTypeAny, rawArgs ?? {});
  if (!parsed.ok || parsed.value === undefined) {
    const error = `invalid arguments: ${parsed.issues.join('; ')}`;
    ctx.logger.warn({ tool, issues: parsed.issues }, 'tool call rejected: invalid arguments');
    return fail(tool, error);
  }
  const allArgs = parsed.value as ToolArgsMap[ToolName];

  switch (tool) {
    case 'record_symptom': {
      const args = typed(tool, allArgs);
      const applied = applySymptom(args);
      const { fields, stripped } = parseClinicalFields(applied.fields);
      if (stripped.length > 0) ctx.logger.warn({ tool, stripped }, 'stripped non-canonical fields');
      return {
        tool,
        ok: true,
        fields,
        extractions: [applied.extraction],
        nextSteps: applied.nextSteps,
        toolResponse: { status: 'recorded', tool, fields, nextSteps: applied.nextSteps },
      };
    }

    case 'record_medication_adherence': {
      const args = typed(tool, allArgs);
      const fields: Partial<ClinicalFields> = {
        medication_adherent: args.taken,
        ...(args.issues ? { medication_issues: [args.issues] } : {}),
      };
      return {
        tool,
        ok: true,
        fields,
        extractions: [
          { field: 'medication_adherent', value: args.taken, confidence: null },
          {
            field: `medication:${args.medication}`,
            value: { taken: args.taken, issues: args.issues ?? null },
            confidence: null,
          },
          ...(args.issues ? [{ field: 'medication_issues', value: args.issues, confidence: null }] : []),
        ],
        nextSteps: args.issues ? [`Medication issue raised: ${args.issues}`] : [],
        toolResponse: { status: 'recorded', tool, medication: args.medication, taken: args.taken },
      };
    }

    case 'record_vital': {
      const args = typed(tool, allArgs);
      const canonical = VITAL_NAME_CANONICAL[args.name];
      if (canonical === null || canonical === undefined) {
        // Not a ClinicalFields concept (spo2 / heart_rate): keep as namespaced raw value.
        return {
          tool,
          ok: true,
          fields: {},
          extractions: [{ field: `vital:${args.name}`, value: args.value, confidence: null }],
          nextSteps: [],
          toolResponse: { status: 'recorded', tool, name: args.name, value: args.value },
        };
      }
      const candidate = { [canonical]: args.value } as Partial<ClinicalFields>;
      const { fields, stripped } = parseClinicalFields(candidate);
      if (stripped.length > 0) {
        const error = `vital "${args.name}" value ${args.value} rejected by clinical schema (${stripped.join(', ')})`;
        ctx.logger.warn({ tool, canonical, value: args.value, stripped }, error);
        return {
          tool,
          ok: false,
          fields: {},
          extractions: [{ field: `vital:${args.name}`, value: args.value, confidence: null }],
          nextSteps: [],
          error,
          toolResponse: { status: 'rejected', tool, error: 'value out of plausible range' },
        };
      }
      return {
        tool,
        ok: true,
        fields,
        extractions: [
          { field: canonical, value: args.value, confidence: null },
          { field: `vital:${args.name}`, value: args.value, confidence: null },
        ],
        nextSteps: [],
        toolResponse: { status: 'recorded', tool, field: canonical, value: args.value },
      };
    }

    case 'flag_red_flag': {
      const args = typed(tool, allArgs);
      // Proposal only — the escalation engine decides. Recorded for audit / eval review.
      if (ctx.repos) {
        await ctx.repos.extractions.append({
          callId: ctx.callId,
          field: `red_flag_proposal:${args.symptom}`,
          value: { reason: args.reason, urgency: args.urgency },
          confidence: null,
        });
      }
      ctx.logger.info({ tool, ...args }, 'red-flag proposal recorded (escalation engine decides)');
      return {
        tool,
        ok: true,
        fields: {},
        extractions: [],
        nextSteps: [],
        toolResponse: {
          status: 'noted',
          tool,
          detail: 'Recorded as a proposal. Clinical escalation rules determine whether a clinician is paged.',
        },
      };
    }

    case 'schedule_followup_callback': {
      const args = typed(tool, allArgs);
      const rawDate = args.iso_datetime.trim();
      if (!ISO_DATEISH.test(rawDate)) {
        return fail(tool, `iso_datetime "${args.iso_datetime}" is not an ISO date/datetime`);
      }
      const scheduledFor = new Date(rawDate.replace(' ', 'T'));
      if (Number.isNaN(scheduledFor.getTime())) {
        return fail(tool, `iso_datetime "${args.iso_datetime}" is not a valid date`);
      }
      if (ctx.repos) {
        await ctx.repos.followups.append({ callId: ctx.callId, scheduledFor, reason: args.reason });
      }
      return {
        tool,
        ok: true,
        fields: { followup_confirmed: true },
        extractions: [{ field: 'followup_confirmed', value: true, confidence: null }],
        nextSteps: [`Callback scheduled ${scheduledFor.toISOString()} — ${args.reason}`],
        followup: { scheduledFor, reason: args.reason },
        toolResponse: { status: 'scheduled', tool, scheduled_for: scheduledFor.toISOString(), reason: args.reason },
      };
    }

    case 'end_call': {
      const args = typed(tool, allArgs);
      return {
        tool,
        ok: true,
        fields: {},
        extractions: [],
        nextSteps: [],
        endCall: args.outcome,
        toolResponse: { status: 'ending', tool, outcome: args.outcome },
      };
    }

    case 'record_identity_verification': {
      const args = typed(tool, allArgs);
      return {
        tool,
        ok: true,
        fields: { identity_verified: args.verified },
        extractions: [
          {
            field: 'identity_verified',
            value: args.verified,
            confidence: null,
          },
        ],
        nextSteps: args.verified
          ? []
          : ['Identity could not be confirmed — staff callback required'],
        toolResponse: { status: 'recorded', tool, verified: args.verified, method: args.method },
      };
    }
  }
}


