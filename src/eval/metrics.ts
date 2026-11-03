/** Eval metric math. Pure functions — unit-tested in tests/unit/evalMetrics.test.ts. */

export interface Prf {
  precision: number;
  recall: number;
  f1: number;
}

export function prf(tp: number, fp: number, fn: number): Prf {
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? null;
}

export interface FieldOutcome {
  field: string;
  expected: unknown;
  actual: unknown;
  correct: boolean;
}

/** Numeric tolerance for temperatures / severity floats. */
function valuesMatch(expected: unknown, actual: unknown): boolean {
  if (typeof expected === 'number' && typeof actual === 'number') return Math.abs(expected - actual) <= 0.05;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    return expected.every((item) => actual.some((candidate) => valuesMatch(item, candidate)));
  }
  return expected === actual;
}

/**
 * Fields the orchestrator derives from tool side-effects rather than from patient
 * speech (a scheduled callback becomes a `next_steps` line). They are real state, but
 * their wording is not ground-truthed, so they are excluded from extraction false
 * positives. Escalation and follow-up correctness is scored by their own metrics.
 */
export const DERIVED_EXTRACTION_FIELDS: readonly string[] = ['next_steps'];

/**
 * Per-field extraction scoring.
 *
 * Aggregation rule (per the build plan): the LAST non-null value per field wins across
 * turns — that folding already happened in the orchestrator's field merge, so `actual`
 * is the call-level state.
 */
export function scoreExtractions(
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
): { fields: FieldOutcome[]; tp: number; fp: number; fn: number; prf: Prf } {
  const fields: FieldOutcome[] = [];
  let tp = 0;
  let fn = 0;
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (expectedValue === undefined) continue;
    const actualValue = actual[field];
    const correct = actualValue !== undefined && actualValue !== null && valuesMatch(expectedValue, actualValue);
    fields.push({ field, expected: expectedValue, actual: actualValue ?? null, correct });
    if (correct) tp += 1;
    else fn += 1;
  }

  const expectedFields = new Set(Object.keys(expected));
  let fp = 0;
  for (const [field, actualValue] of Object.entries(actual)) {
    if (expectedFields.has(field) || DERIVED_EXTRACTION_FIELDS.includes(field)) continue;
    const isEmpty =
      actualValue === undefined ||
      actualValue === null ||
      (Array.isArray(actualValue) && actualValue.length === 0);
    if (!isEmpty) {
      fp += 1;
      fields.push({ field, expected: null, actual: actualValue, correct: false });
    }
  }

  return { fields, tp, fp, fn, prf: prf(tp, fp, fn) };
}

export interface SetScore extends Prf {
  expected: string[];
  actual: string[];
  tp: number;
  fp: number;
  fn: number;
  missing: string[];
  spurious: string[];
  exact: boolean;
}

export function scoreSets(expected: readonly string[], actual: readonly string[]): SetScore {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const tp = [...expectedSet].filter((id) => actualSet.has(id)).length;
  const fp = [...actualSet].filter((id) => !expectedSet.has(id)).length;
  const fn = [...expectedSet].filter((id) => !actualSet.has(id)).length;
  return {
    ...prf(tp, fp, fn),
    expected: [...expectedSet],
    actual: [...actualSet],
    tp,
    fp,
    fn,
    missing: [...expectedSet].filter((id) => !actualSet.has(id)),
    spurious: [...actualSet].filter((id) => !expectedSet.has(id)),
    exact: tp === expectedSet.size && fp === 0,
  };
}

export function stepAdherence(expected: readonly string[], completed: readonly string[]): SetScore {
  return scoreSets(expected, completed);
}
