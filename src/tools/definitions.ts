import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ToolDefinition } from '../llm/types.js';

/**
 * LLM-callable tools. Arguments are Zod schemas (validated again server-side in
 * handlers.ts — the model is never trusted). Compiled to JSON Schema for the
 * OpenAI-style `tools` field.
 *
 * Note `end_call`: `no_answer` is deliberately absent — that is a telephony lifecycle
 * *status* from Twilio status callbacks, never a model-initiated *outcome*.
 */

export const RecordSymptomArgs = z.object({
  symptom: z.enum([
    'pain',
    'fever',
    'shortness_of_breath',
    'chest_pain',
    'wound',
    'nausea',
    'dizziness',
    'other',
  ]),
  severity: z.number().int().min(1).max(10).describe('Patient-reported severity, 1 (mild) to 10 (worst)'),
  onset: z.string().min(1).describe('When it started, e.g. "last night" or "2 days ago"'),
  /**
   * false = the patient explicitly denied this symptom. Needed because canonical fields
   * are tri-state (unknown / yes / no) and "no chest pain" is clinically meaningful.
   */
  presence: z.boolean().default(true),
  notes: z.string().optional(),
});

export const RecordMedicationAdherenceArgs = z.object({
  medication: z.string().min(1),
  taken: z.boolean().describe('true if the patient has been taking it as prescribed'),
  issues: z.string().optional().describe('Side effects, cost, skipped doses, etc.'),
});

export const RecordVitalArgs = z.object({
  name: z.enum(['temperature_f', 'heart_rate', 'spo2']),
  value: z.number(),
});

export const FlagRedFlagArgs = z.object({
  symptom: z.string().min(1),
  reason: z.string().min(1),
  urgency: z.enum(['routine', 'urgent', 'emergent']),
});

export const ScheduleFollowupCallbackArgs = z.object({
  iso_datetime: z
    .string()
    .min(4)
    .describe('ISO-8601 date or datetime for the callback, e.g. 2026-11-05T09:30:00Z'),
  reason: z.string().min(1),
});

export const EndCallArgs = z.object({
  outcome: z.enum(['completed', 'refused', 'partial', 'escalated']),
});

/**
 * Deviation from PLAN.md's six-tool list (documented in BUILD_REPORT.md): the canonical
 * field `identity_verified` has no write path among those six, and inventing a free-form
 * field would break the canonical-vocabulary rule. This tool is that write path.
 */
export const RecordIdentityVerificationArgs = z.object({
  verified: z.boolean(),
  method: z.enum(['dob', 'name_and_dob', 'other']).default('dob'),
  note: z.string().optional(),
});

export const TOOL_ARGUMENT_SCHEMAS = {
  record_symptom: RecordSymptomArgs,
  record_medication_adherence: RecordMedicationAdherenceArgs,
  record_vital: RecordVitalArgs,
  flag_red_flag: FlagRedFlagArgs,
  schedule_followup_callback: ScheduleFollowupCallbackArgs,
  end_call: EndCallArgs,
  record_identity_verification: RecordIdentityVerificationArgs,
} as const;

export type ToolName = keyof typeof TOOL_ARGUMENT_SCHEMAS;
export const TOOL_NAMES = Object.keys(TOOL_ARGUMENT_SCHEMAS) as ToolName[];

const DESCRIPTIONS: Record<ToolName, string> = {
  record_symptom:
    'Record a symptom the patient reported during this call, with severity and onset. Call once per distinct symptom.',
  record_medication_adherence:
    'Record whether the patient is taking a specific prescribed medication as directed, and any issues.',
  record_vital:
    'Record a vital-sign value the patient reports. Use temperature_f for a thermometer reading in Fahrenheit.',
  flag_red_flag:
    'Propose that a red flag needs human attention. This is only a PROPOSAL: the deterministic escalation rules decide whether a human is notified.',
  schedule_followup_callback: 'Schedule a callback for the patient when one is agreed on the call.',
  end_call: 'End the call once all steps are done, the patient refuses, or the call cannot continue.',
  record_identity_verification:
    'Record whether the patient confirmed their identity (e.g. by date of birth). Set verified=false when they could not.',
};

/** JSON Schema for a tool's arguments (OpenAI `tools[].function.parameters` shape). */
export function toolParameterSchema(name: ToolName): Record<string, unknown> {
  const compiled = zodToJsonSchema(TOOL_ARGUMENT_SCHEMAS[name], { name }) as Record<string, unknown>;
  delete compiled.$schema;
  delete compiled.$defs;
  delete compiled.definitions;
  compiled.additionalProperties = false;
  return compiled;
}

/** Narrowed argument types per tool, used by handlers.ts. */
export interface ToolArgsMap {
  record_symptom: z.output<typeof RecordSymptomArgs>;
  record_medication_adherence: z.output<typeof RecordMedicationAdherenceArgs>;
  record_vital: z.output<typeof RecordVitalArgs>;
  flag_red_flag: z.output<typeof FlagRedFlagArgs>;
  schedule_followup_callback: z.output<typeof ScheduleFollowupCallbackArgs>;
  end_call: z.output<typeof EndCallArgs>;
  record_identity_verification: z.output<typeof RecordIdentityVerificationArgs>;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = TOOL_NAMES.map((name) => ({
  name,
  description: DESCRIPTIONS[name],
  parameters: toolParameterSchema(name),
}));

export { TOOL_DEFINITIONS as defaultToolDefinitions };
