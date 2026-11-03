import { z } from 'zod';

/**
 * Canonical clinical vocabulary — ONE source of truth shared by extraction,
 * escalation rules, tool handlers, fixtures and eval ground truth.
 *
 * Escalation rules and ground truth reference these canonical names only; the
 * `record_vital` tool canonicalizes aliases (`temperature_f` -> `fever_f`) in
 * src/tools/handlers.ts.
 *
 * SYNTHETIC DATA ONLY: nothing here, and no fixture using it, is real PHI.
 */
export const CLINICAL_FIELD_KEYS = [
  'identity_verified',
  'pain_score',
  'fever_f',
  'shortness_of_breath',
  'chest_pain',
  'wound_concern',
  'medication_adherent',
  'medication_issues',
  'followup_confirmed',
  'next_steps',
] as const;

export const ClinicalFields = z.object({
  identity_verified: z.boolean().optional(),
  pain_score: z.number().int().min(0).max(10).optional(),
  fever_f: z.number().min(90).max(115).optional(),
  shortness_of_breath: z.enum(['none', 'mild', 'moderate', 'severe']).optional(),
  chest_pain: z.boolean().optional(),
  wound_concern: z.boolean().optional(),
  medication_adherent: z.boolean().optional(),
  medication_issues: z.array(z.string()).default([]),
  followup_confirmed: z.boolean().optional(),
  next_steps: z.array(z.string()).default([]),
});

export type ClinicalFieldName = (typeof CLINICAL_FIELD_KEYS)[number];
export type ClinicalFields = z.output<typeof ClinicalFields>;
export type ClinicalFieldsInput = z.input<typeof ClinicalFields>;

export type ClinicalFieldKind = 'boolean' | 'number' | 'enum' | 'string_array';

/** Drives the `op`/value type checks at call-script load time. */
export const CLINICAL_FIELD_KIND: Record<ClinicalFieldName, ClinicalFieldKind> = {
  identity_verified: 'boolean',
  pain_score: 'number',
  fever_f: 'number',
  shortness_of_breath: 'enum',
  chest_pain: 'boolean',
  wound_concern: 'boolean',
  medication_adherent: 'boolean',
  medication_issues: 'string_array',
  followup_confirmed: 'boolean',
  next_steps: 'string_array',
};

export const CLINICAL_FIELD_ENUM_VALUES: Partial<Record<ClinicalFieldName, readonly string[]>> = {
  shortness_of_breath: ['none', 'mild', 'moderate', 'severe'],
};

export function isClinicalFieldName(key: string): key is ClinicalFieldName {
  return (CLINICAL_FIELD_KEYS as readonly string[]).includes(key);
}

export function emptyClinicalFields(): ClinicalFields {
  return { medication_issues: [], next_steps: [] };
}

/** Result of validating a raw extraction payload against the canonical schema. */
export interface ClinicalFieldSplit {
  fields: ClinicalFields;
  /** Keys dropped because they are unknown or failed validation — logged, never kept. */
  stripped: string[];
}

export function parseClinicalFields(raw: unknown): ClinicalFieldSplit {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { fields: emptyClinicalFields(), stripped: ['<not an object>'] };
  }
  const known: Record<string, unknown> = {};
  const stripped: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (isClinicalFieldName(key)) known[key] = value;
    else stripped.push(key);
  }
  const parsed = ClinicalFields.safeParse(known);
  if (!parsed.success) {
    const rejected = parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.code}`);
    // Keep whatever validated cleanly by re-parsing without the offending keys.
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key === 'string') delete known[key];
    }
    const partial = ClinicalFields.safeParse(known);
    return {
      fields: partial.success ? partial.data : emptyClinicalFields(),
      stripped: [...stripped, ...rejected],
    };
  }
  return { fields: parsed.data, stripped };
}

/** Merge an incremental extraction into the running per-call field state. */
export function mergeClinicalFields(
  current: ClinicalFields,
  incoming: Partial<ClinicalFields>,
): ClinicalFields {
  const next: ClinicalFields = { ...current };
  for (const [key, value] of Object.entries(incoming) as [keyof ClinicalFields, unknown][]) {
    if (value === undefined) continue;
    if (key === 'medication_issues' || key === 'next_steps') {
      const existing = (current[key] as string[] | undefined) ?? [];
      const added = Array.isArray(value) ? (value as string[]) : [];
      next[key] = [...new Set([...existing, ...added])] as ClinicalFields[typeof key];
      continue;
    }
    // Scalars: latest explicit value wins (matches eval aggregation semantics).
    (next[key] as unknown) = value;
  }
  return next;
}

/** Per-turn LLM output contract. */
export const TurnExtraction = z.object({
  utterance: z.string(),
  extracted_fields: ClinicalFields,
  step_complete: z.boolean(),
});
export type TurnExtraction = z.output<typeof TurnExtraction>;
