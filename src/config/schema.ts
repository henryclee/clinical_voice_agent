import { z } from 'zod';
import {
  CLINICAL_FIELD_ENUM_VALUES,
  CLINICAL_FIELD_KIND,
  CLINICAL_FIELD_KEYS,
  type ClinicalFieldName,
} from '../extraction/clinicalFields.js';
import { assertKnownPlaceholders, findPlaceholders } from './interpolate.js';

/**
 * Call-script format, validated at load time. Design intent: the *script* is
 * configuration, the *state machine* is code — adding a call type must not require
 * touching the orchestrator.
 */

export const RULE_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'exists'] as const;
export type RuleOp = (typeof RULE_OPS)[number];

export const URGENCIES = ['routine', 'urgent', 'emergent'] as const;
export type Urgency = (typeof URGENCIES)[number];

/** Higher rank wins when deciding which escalation action to take. */
export const URGENCY_RANK: Record<Urgency, number> = { routine: 1, urgent: 2, emergent: 3 };

export const STEP_ON_FAILURE = ['retry', 'advance_with_flag', 'warm_transfer_to_staff'] as const;
export type StepOnFailure = (typeof STEP_ON_FAILURE)[number];

export const EscalationWhen = z.object({
  field: z.enum(CLINICAL_FIELD_KEYS),
  op: z.enum(RULE_OPS),
  value: z.unknown(),
});

export const EscalationRule = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/, 'rule id must be snake_case'),
  when: EscalationWhen,
  urgency: z.enum(URGENCIES),
  reason: z.string().min(3),
});
export type EscalationRule = z.output<typeof EscalationRule>;
export type RuleField = ClinicalFieldName;

export const CallScriptStep = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/, 'step id must be snake_case'),
  instruction: z.string().min(3),
  required: z.boolean().default(true),
  max_attempts: z.number().int().min(1).max(6).default(2),
  on_failure: z.enum(STEP_ON_FAILURE).default('retry'),
});
export type CallScriptStep = z.output<typeof CallScriptStep>;

/**
 * `op`/value type compatibility against the canonical field kind. A rule that can
 * never match (e.g. `gt` against a boolean, or `eq` against an out-of-range enum
 * value) is rejected at load time instead of silently doing nothing at runtime.
 */
export function ruleTypeIssues(rule: EscalationRule): string[] {
  const issues: string[] = [];
  const field = rule.when.field as ClinicalFieldName;
  const kind = CLINICAL_FIELD_KIND[field];
  const { op, value } = rule.when;

  if (op === 'exists') {
    if (value !== undefined && value !== null) {
      issues.push(`rule ${rule.id}: op "exists" takes no value (got ${JSON.stringify(value)})`);
    }
    return issues;
  }

  if (value === undefined || value === null) {
    issues.push(`rule ${rule.id}: op "${op}" requires a value for field "${field}"`);
    return issues;
  }

  if (op === 'in') {
    if (!Array.isArray(value) || value.length === 0) {
      issues.push(`rule ${rule.id}: op "in" requires a non-empty array value`);
    }
  } else if (Array.isArray(value)) {
    issues.push(`rule ${rule.id}: op "${op}" does not take an array value`);
  }

  const candidates: unknown[] = op === 'in' && Array.isArray(value) ? value : [value];

  switch (kind) {
    case 'boolean':
      if (!['eq', 'neq', 'exists'].includes(op)) {
        issues.push(`rule ${rule.id}: field "${field}" is boolean; only eq/neq/exists are valid`);
      }
      for (const candidate of candidates) {
        if (typeof candidate !== 'boolean') {
          issues.push(`rule ${rule.id}: field "${field}" expects a boolean, got ${JSON.stringify(candidate)}`);
        }
      }
      break;
    case 'number':
      if (!['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in'].includes(op)) {
        issues.push(`rule ${rule.id}: field "${field}" is numeric; unsupported op "${op}"`);
      }
      for (const candidate of candidates) {
        if (typeof candidate !== 'number' || Number.isNaN(candidate)) {
          issues.push(`rule ${rule.id}: field "${field}" expects a number, got ${JSON.stringify(candidate)}`);
        }
      }
      break;
    case 'enum': {
      const allowed = CLINICAL_FIELD_ENUM_VALUES[field] ?? [];
      for (const candidate of candidates) {
        if (typeof candidate !== 'string' || !allowed.includes(candidate)) {
          issues.push(
            `rule ${rule.id}: field "${field}" expects one of [${allowed.join(', ')}], got ${JSON.stringify(candidate)}`,
          );
        }
      }
      break;
    }
    case 'string_array':
      if (!['exists', 'in'].includes(op)) {
        issues.push(`rule ${rule.id}: field "${field}" is a string array; only exists/in are valid`);
      }
      break;
  }
  return issues;
}

export const CallScript = z
  .object({
    id: z.string().regex(/^[a-z0-9_]+$/, 'script id must be snake_case'),
    version: z.number().int().min(1),
    persona: z.string().min(10),
    steps: z.array(CallScriptStep).min(1),
    escalation_rules: z.array(EscalationRule).default([]),
  })
  .superRefine((script, ctx) => {
    const seenSteps = new Set<string>();
    for (const step of script.steps) {
      if (seenSteps.has(step.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate step id "${step.id}"` });
      }
      seenSteps.add(step.id);
    }

    const seenRules = new Set<string>();
    for (const rule of script.escalation_rules) {
      if (seenRules.has(rule.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate escalation rule id "${rule.id}"` });
      }
      seenRules.add(rule.id);
      for (const message of ruleTypeIssues(rule)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message });
      }
    }

    const texts = [script.persona, ...script.steps.map((s) => s.instruction)];
    try {
      assertKnownPlaceholders(texts, 'call script');
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
export type CallScript = z.output<typeof CallScript>;

export function deriveRequiredSteps(script: CallScript): string[] {
  return script.steps.filter((step) => step.required).map((step) => step.id);
}

/** Re-exported for callers that only need the placeholder whitelist. */
export { findPlaceholders };

