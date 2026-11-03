import type { CallOutcome } from '../db/schema.js';
import type { EscalationRow, ExtractionRow, FollowupRow } from '../db/repositories/types.js';
import type { ClinicalFields } from './clinicalFields.js';

/** Structured staff summary — the shape PLAN Module C specifies. */
export interface StaffSummaryEscalation {
  rule_id: string;
  urgency: 'routine' | 'urgent' | 'emergent';
  reason: string;
}

export interface StaffSummary {
  call_outcome: CallOutcome | null;
  symptoms_reported: string[];
  medication_issues: string[];
  escalations: StaffSummaryEscalation[];
  next_steps: string[];
  one_line_summary: string;
}

export interface SummarizeInput {
  patientName: string;
  outcome: CallOutcome | null;
  fields: ClinicalFields;
  escalations: readonly EscalationRow[];
  followups?: readonly FollowupRow[];
  flags?: readonly string[];
  missingRequired?: readonly string[];
}

export function summarize(input: SummarizeInput): StaffSummary {
  const f = input.fields;
  const symptoms: string[] = [];
  if (f.pain_score !== undefined) symptoms.push(`pain ${f.pain_score}/10`);
  if (f.fever_f !== undefined) symptoms.push(`fever ${f.fever_f}F`);
  if (f.shortness_of_breath !== undefined) symptoms.push(`shortness of breath: ${f.shortness_of_breath}`);
  if (f.chest_pain !== undefined) symptoms.push(`chest pain: ${f.chest_pain ? 'yes' : 'no'}`);
  if (f.wound_concern !== undefined) symptoms.push(`wound concern: ${f.wound_concern ? 'yes' : 'no'}`);

  const escalations: StaffSummaryEscalation[] = input.escalations.map((e) => ({
    rule_id: e.ruleId,
    urgency: e.urgency,
    reason: e.reason,
  }));

  const oneLine = [
    input.patientName,
    input.outcome ?? 'unknown outcome',
    escalations.length > 0 ? `escalated (${escalations.map((e) => e.rule_id).join(', ')})` : 'no escalation',
    `${symptoms.length} symptom item${symptoms.length === 1 ? '' : 's'}`,
  ].join(' — ');

  return {
    call_outcome: input.outcome,
    symptoms_reported: symptoms,
    medication_issues: [...f.medication_issues],
    escalations,
    next_steps: [...f.next_steps],
    one_line_summary: oneLine,
  };
}

/** Human-readable rendering persisted into `calls.summary_text`. */
export function renderSummaryText(summary: StaffSummary, input: SummarizeInput): string {
  const lines: string[] = [];
  lines.push(`Post-discharge follow-up — ${input.patientName}`);
  lines.push(`Outcome: ${summary.call_outcome ?? 'unknown'}`);
  lines.push(`Identity verified: ${input.fields.identity_verified === true ? 'yes' : 'no'}`);
  lines.push(
    summary.symptoms_reported.length > 0
      ? `Symptoms: ${summary.symptoms_reported.join(' | ')}`
      : 'Symptoms: none recorded',
  );
  lines.push(
    summary.medication_issues.length > 0
      ? `Medication issues: ${summary.medication_issues.join(' | ')}`
      : 'Medication issues: none reported',
  );
  lines.push(
    summary.escalations.length > 0
      ? `Escalations: ${summary.escalations.map((e) => `${e.rule_id} (${e.urgency}) — ${e.reason}`).join(' | ')}`
      : 'Escalations: none',
  );
  if (input.followups && input.followups.length > 0) {
    lines.push(
      `Callbacks: ${input.followups.map((c) => `${c.scheduledFor.toISOString()} — ${c.reason}`).join(' | ')}`,
    );
  }
  if (input.flags && input.flags.length > 0) lines.push(`Flags: ${input.flags.join(', ')}`);
  if (input.missingRequired && input.missingRequired.length > 0) {
    lines.push(`Missing required steps: ${input.missingRequired.join(', ')}`);
  }
  lines.push('Next steps:');
  if (summary.next_steps.length > 0) {
    for (const step of summary.next_steps) lines.push(`  - ${step}`);
  } else {
    lines.push('  - none recorded');
  }
  return lines.join('\n');
}

/** Reconstruct canonical fields from persisted extraction rows (audit / summary path). */
export function fieldsFromExtractionRows(rows: readonly ExtractionRow[], base: ClinicalFields): ClinicalFields {
  return rows.reduce<ClinicalFields>((acc, row) => {
    if (row.field === 'medication_issues' && typeof row.value === 'string') {
      return { ...acc, medication_issues: [...new Set([...acc.medication_issues, row.value])] };
    }
    if (row.field.includes(':')) return acc;
    return { ...acc, [row.field]: row.value } as ClinicalFields;
  }, { ...base });
}
