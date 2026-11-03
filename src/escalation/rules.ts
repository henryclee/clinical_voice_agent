import type { CallScript } from '../config/schema.js';
import { URGENCY_RANK, type EscalationRule, type RuleOp } from '../config/schema.js';
import type { ClinicalFieldName } from '../extraction/clinicalFields.js';

/**
 * Rule catalog helpers. The rules themselves live in the call script (configuration);
 * this module is for composing and explaining them — e.g. eval scenarios that want to
 * assert on a rule without duplicating its wording.
 */

export interface RuleCatalogEntry {
  id: string;
  description: string;
  defaultUrgency: EscalationRule['urgency'];
  op: RuleOp;
  field: ClinicalFieldName;
}

/** Catalog of the red flags the shipped script watches (documentation + eval labels). */
export const DEFAULT_RULE_CATALOG: RuleCatalogEntry[] = [
  { id: 'fever_high', description: 'Fever >= 100.4F after discharge', defaultUrgency: 'urgent', op: 'gte', field: 'fever_f' },
  { id: 'chest_pain', description: 'Any chest pain reported', defaultUrgency: 'emergent', op: 'eq', field: 'chest_pain' },
  { id: 'severe_sob', description: 'Severe shortness of breath', defaultUrgency: 'emergent', op: 'eq', field: 'shortness_of_breath' },
  { id: 'identity_failed', description: 'Identity could not be verified', defaultUrgency: 'routine', op: 'eq', field: 'identity_verified' },
];

export function rulesFromScript(script: CallScript): EscalationRule[] {
  return script.escalation_rules;
}

/** Union two rule sets, script rules winning on id collisions (used by eval overrides). */
export function mergeRuleSets(base: readonly EscalationRule[], extra: readonly EscalationRule[]): EscalationRule[] {
  const byId = new Map<string, EscalationRule>();
  for (const rule of extra) byId.set(rule.id, rule);
  for (const rule of base) byId.set(rule.id, rule);
  return [...byId.values()].sort(
    (a, b) => URGENCY_RANK[b.urgency] - URGENCY_RANK[a.urgency] || a.id.localeCompare(b.id),
  );
}

export function describeRule(rule: EscalationRule): string {
  const value = rule.when.op === 'exists' ? '' : ` ${JSON.stringify(rule.when.value)}`;
  return `${rule.when.field} ${rule.when.op}${value} -> ${rule.urgency} (${rule.id})`;
}
