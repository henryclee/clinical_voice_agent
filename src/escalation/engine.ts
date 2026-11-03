import type { ClinicalFields } from '../extraction/clinicalFields.js';
import { CLINICAL_FIELD_KIND } from '../extraction/clinicalFields.js';
import { URGENCY_RANK, type EscalationRule, type Urgency } from '../config/schema.js';

/**
 * Deterministic escalation engine — "the model proposes, rules decide".
 *
 * The LLM can call `flag_red_flag`, but that call has NO authority here: escalation is
 * computed from canonical field state against the script's rules. This module is pure
 * (no I/O, no clock, no LLM) which is why it carries the coverage threshold.
 */

export interface EscalationDecision {
  ruleId: string;
  urgency: Urgency;
  reason: string;
  field: string;
  matchedValue: unknown;
}

/** What the caller must do about a decision. */
export type EscalationAction = 'record_only' | 'advise_and_finish' | 'terminate_now';

function isPresent(field: keyof ClinicalFields, value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (CLINICAL_FIELD_KIND[field] === 'string_array') return Array.isArray(value) && value.length > 0;
  return true;
}

export function ruleMatches(rule: EscalationRule, fields: ClinicalFields): { matched: boolean; value: unknown } {
  const field = rule.when.field;
  const value = fields[field];
  const op = rule.when.op;

  if (op === 'exists') return { matched: isPresent(field, value), value };

  if (!isPresent(field, value)) return { matched: false, value };

  switch (op) {
    case 'eq':
      return { matched: value === rule.when.value, value };
    case 'neq':
      return { matched: value !== rule.when.value, value };
    case 'in':
      return {
        matched: Array.isArray(rule.when.value) && rule.when.value.includes(value as never),
        value,
      };
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      // Numeric compare, with a guarded string-number fallback ("101.5" from a model).
      const left = typeof value === 'number' ? value : Number(value);
      const right =
        typeof rule.when.value === 'number'
          ? rule.when.value
          : Number.parseInt(String(rule.when.value), 10);
      if (Number.isNaN(left) || Number.isNaN(right)) return { matched: false, value };
      if (op === 'gt') return { matched: left > right, value };
      if (op === 'gte') return { matched: left >= right, value };
      if (op === 'lt') return { matched: left < right, value };
      return { matched: left <= right, value };
    }
    default:
      return { matched: false, value };
  }
}

/** All rules that currently match, ordered by descending urgency then rule id. */
export function evaluateRules(rules: readonly EscalationRule[], fields: ClinicalFields): EscalationDecision[] {
  const decisions: EscalationDecision[] = [];
  for (const rule of rules) {
    const { matched, value } = ruleMatches(rule, fields);
    if (!matched) continue;
    decisions.push({ ruleId: rule.id, urgency: rule.urgency, reason: rule.reason, field: rule.when.field, matchedValue: value });
  }
  return decisions.sort(
    (a, b) => URGENCY_RANK[b.urgency] - URGENCY_RANK[a.urgency] || a.ruleId.localeCompare(b.ruleId),
  );
}

export function highest(decisions: readonly EscalationDecision[]): EscalationDecision | null {
  return decisions[0] ?? null;
}

/**
 * Action policy (documented in README):
 *  - emergent  -> stop gathering, say the safety line, end the call `escalated` now.
 *  - urgent    -> record + advise the patient, finish remaining steps, end `escalated`.
 *  - routine   -> record for the audit trail only (e.g. identity-failure bookkeeping).
 */
export function actionFor(decision: EscalationDecision | null): EscalationAction {
  if (!decision) return 'record_only';
  if (decision.urgency === 'emergent') return 'terminate_now';
  if (decision.urgency === 'urgent') return 'advise_and_finish';
  return 'record_only';
}

/** True when the call may no longer end as `completed`. */
export function forcesEscalatedOutcome(decision: EscalationDecision | null): boolean {
  return decision !== null && decision.urgency !== 'routine';
}

export const SAFETY_MESSAGE_EMERGENT =
  'That sounds urgent. Please hang up and call 911 now. I am alerting your care team.';
export const SAFETY_MESSAGE_URGENT =
  'Thank you for telling me. Your care team will call you back shortly. If this gets worse before then, call 911.';
