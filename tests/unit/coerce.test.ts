/**
 * Schema-aware argument coercion. Provable drift ("101.5", True, [value]) is fixed and
 * counted; anything that would require guessing is rejected instead.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { resetToolCallStats, toolCallStats } from '../../src/llm/stats.js';
import { coerceArgs, validateToolArgs } from '../../src/tools/coerce.js';
import { RecordSymptomArgs, RecordVitalArgs } from '../../src/tools/definitions.js';

const base = { symptom: 'pain', severity: 3, onset: '2 days ago' };

beforeEach(() => resetToolCallStats());

describe('validateToolArgs coercion', () => {
  it('accepts a valid payload without coercion', () => {
    const parsed = validateToolArgs(RecordSymptomArgs, base);
    expect(parsed).toMatchObject({ ok: true, coerced: false, issues: [] });
    expect(parsed.value).toMatchObject({ ...base, presence: true });
  });

  it('coerces quoted numbers and string booleans', () => {
    const parsed = validateToolArgs(RecordSymptomArgs, { symptom: 'pain', severity: '7', onset: 'today', presence: 'false' });
    expect(parsed.ok).toBe(true);
    expect(parsed.coerced).toBe(true);
    expect(parsed.value).toMatchObject({ severity: 7, presence: false });
  });

  it('coerces enum casing and unwraps single-element arrays', () => {
    expect(validateToolArgs(RecordSymptomArgs, { ...base, symptom: 'Chest_Pain' }).value).toMatchObject({ symptom: 'chest_pain' });
    expect(validateToolArgs(RecordVitalArgs, { name: 'temperature_f', value: ['101.5'] }).value).toMatchObject({ value: 101.5 });
  });

  it('rejects an enum value with no case-insensitive match', () => {
    const parsed = validateToolArgs(RecordSymptomArgs, { ...base, symptom: 'headache' });
    expect(parsed.ok).toBe(false);
    expect(parsed.issues.join(' ')).toMatch(/symptom/);
  });

  it('rejects out-of-range numbers instead of guessing', () => {
    const parsed = validateToolArgs(RecordSymptomArgs, { ...base, severity: 42 });
    expect(parsed.ok).toBe(false);
    expect(parsed.issues.join(' ')).toMatch(/severity/);
  });

  it('reports every missing required field', () => {
    const parsed = validateToolArgs(RecordSymptomArgs, { symptom: 'pain' });
    expect(parsed.ok).toBe(false);
    expect(parsed.issues.join(' ')).toMatch(/severity/);
    expect(parsed.issues.join(' ')).toMatch(/onset/);
  });

  it('counts each successful coercion in the run stats', () => {
    validateToolArgs(RecordSymptomArgs, { symptom: 'pain', severity: '7', onset: 'today' });
    validateToolArgs(RecordSymptomArgs, { symptom: 'pain', severity: '8', onset: 'today' });
    expect(toolCallStats().coercions).toBe(2);
  });

  it('passes unknown keys through untouched; non-objects become {}', () => {
    const shape = RecordSymptomArgs._def.shape as never;
    const { value, changed } = coerceArgs(shape, { symptom: 'pain', extra_key: 'kept' });
    expect(value).toMatchObject({ symptom: 'pain', extra_key: 'kept' });
    expect(changed).toBe(false);
    expect(coerceArgs({}, 'nope' as never)).toEqual({ value: {}, changed: true });
  });
});
