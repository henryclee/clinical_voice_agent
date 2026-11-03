import type { z } from 'zod';
import { recordCoercion } from '../llm/stats.js';

/**
 * Schema-aware coercion of tool arguments before validation.
 *
 * Local models frequently quote numbers ("101.5"), use Python literals, or wrap a
 * single value in an array. Rather than rejecting those, we fix exactly the classes of
 * drift we can prove against the schema and then re-validate; anything still invalid is
 * rejected (and counted) instead of guessed at.
 */
export interface CoercedParse<T> {
  ok: boolean;
  value?: T;
  issues: string[];
  coerced: boolean;
}

type Shape = Record<string, unknown>;

/**
 * zod v3 stores `_def.typeName` as `"ZodNumber"` etc. and hides the real type behind
 * `default()`/`optional()`/`nullable()` wrappers. Normalize both so coercion actually
 * fires: with a naive lowercase compare, every branch below silently missed and no
 * argument was ever coerced (found by tests/unit/coerce.test.ts).
 */
const TYPE_ALIASES: Record<string, string> = {
  zodnumber: 'number',
  zodboolean: 'boolean',
  zodstring: 'string',
  zodenum: 'enum',
  zodarray: 'array',
  zodobject: 'object',
};

/** Peel `default()` / `optional()` / `nullable()` / `pipe()` down to the real type. */
function unwrap(target: unknown): unknown {
  let current = target;
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof current !== 'object' || current === null) return current;
    const def = (current as { _def?: { innerType?: unknown; schema?: unknown; typeName?: string } })._def;
    if (!def) return current;
    if (def.innerType !== undefined) {
      current = def.innerType;
      continue;
    }
    if (def.typeName === 'ZodEffects' && def.schema !== undefined) {
      current = def.schema;
      continue;
    }
    return current;
  }
  return current;
}

function kindOf(schema: unknown): string | undefined {
  if (typeof schema !== 'object' || schema === null) return undefined;
  const candidate = schema as { _def?: { typeName?: string } };
  const typeName = candidate._def?.typeName;
  if (typeof typeName !== 'string') return undefined;
  const lowered = typeName.toLowerCase();
  return TYPE_ALIASES[lowered] ?? lowered;
}

function coerceValue(target: unknown, value: unknown): { value: unknown; changed: boolean } {
  target = unwrap(target);
  const typeName = kindOf(target);
  if (typeName === undefined || value === null) return { value, changed: false };

  switch (typeName) {
    case 'number': {
      if (typeof value === 'string') {
        const parsed = Number(value.replace(/[^0-9.eE+-]/g, ''));
        if (!Number.isNaN(parsed)) return { value: parsed, changed: true };
      }
      if (typeof value === 'boolean') return { value: value ? 1 : 0, changed: true };
      if (Array.isArray(value) && value.length === 1) return coerceValue(target, value[0]);
      return { value, changed: false };
    }
    case 'boolean': {
      if (typeof value === 'string') {
        const lower = value.trim().toLowerCase();
        if (['true', 'yes', 'y', '1'].includes(lower)) return { value: true, changed: true };
        if (['false', 'no', 'n', '0'].includes(lower)) return { value: false, changed: true };
      }
      if (typeof value === 'number') return { value: value !== 0, changed: true };
      return { value, changed: false };
    }
    case 'string': {
      if (typeof value === 'number' || typeof value === 'boolean') {
        return { value: String(value), changed: true };
      }
      return { value, changed: false };
    }
    case 'enum': {
      const values: unknown[] = ((target as { _def?: { values?: unknown[] } })._def?.values ?? []) as unknown[];
      if (typeof value === 'string') {
        const hit = values.find((allowed) => String(allowed).toLowerCase() === value.trim().toLowerCase());
        if (hit !== undefined && hit !== value) return { value: hit, changed: true };
      }
      return { value, changed: false };
    }
    case 'array': {
      const element = (target as { _def?: { type?: unknown } })._def?.type;
      if (!Array.isArray(value)) {
        if (value === undefined || value === '') return { value: [], changed: true };
        if (element) {
          const inner = coerceValue(element, value);
          return { value: [inner.value], changed: true };
        }
        return { value: [value], changed: true };
      }
      if (!element) return { value, changed: false };
      let changed = false;
      const mapped = value.map((item) => {
        const inner = coerceValue(element, item);
        changed = changed || inner.changed;
        return inner.value;
      });
      return { value: mapped, changed };
    }
    case 'object': {
      const shape = (target as { _def?: { shape?: Shape } })._def?.shape;
      if (!shape || typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { value, changed: false };
      }
      const { value: nested, changed } = coerceArgs(schemaShape(shape), value as Shape);
      return { value: nested, changed };
    }
    default:
      return { value, changed: false };
  }
}

function schemaShape(schema: unknown): Shape {
  // zod v3 stores the shape as a thunk (`_def.shape()`); zod v4 stores it directly.
  const shape = (schema as { _def?: { shape?: Shape | (() => Shape) } })._def?.shape;
  if (typeof shape === 'function') return shape() as Shape;
  return (shape ?? {}) as Shape;
}

export function coerceArgs(targetShape: Shape, raw: unknown): { value: Shape; changed: boolean } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { value: {}, changed: true };
  const input = raw as Shape;
  const out: Shape = {};
  let changed = false;
  for (const [key, value] of Object.entries(input)) {
    const target = targetShape[key];
    if (target === undefined) {
      out[key] = value;
      continue;
    }
    const coerced = coerceValue(target, value);
    changed = changed || coerced.changed;
    out[key] = coerced.value;
  }
  return { value: out, changed };
}

/** Validate tool arguments, coercing provable drift first. Never throws. */
export function validateToolArgs<T>(schema: z.ZodType<T>, raw: unknown): CoercedParse<T> {
  const direct = schema.safeParse(raw);
  if (direct.success) return { ok: true, value: direct.data, issues: [], coerced: false };

  const shape = schemaShape(schema);
  const { value: coercedRaw, changed } = coerceArgs(shape, raw);
  if (changed) {
    const retried = schema.safeParse(coercedRaw);
    if (retried.success) {
      recordCoercion(1);
      return { ok: true, value: retried.data, issues: [], coerced: true };
    }
  }
  return {
    ok: false,
    issues: direct.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`),
    coerced: changed,
  };
}
