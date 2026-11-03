import type { ToolCall } from './types.js';
import { recordAccepted, recordCoercion, recordRejected, recordTier, type ParseOutcome } from './stats.js';

/**
 * Tool-call tolerance layer.
 *
 * Local models (omlx / Qwen included) emit tool calls in inconsistent shapes. The
 * orchestrator must NEVER depend on them, so parsing is aggressively tolerant and every
 * failure path degrades to `[]` + a log line instead of throwing. Tiers, in order:
 *
 *   1. native      — `tool_calls` array on the response message
 *   2. inline_tag  — `<tool_call>{...}</tool_call>` blocks inside `text`
 *   3. fenced_json — ```json {...} ``` blocks with `name` + `arguments`
 *   4. bare_json   — a bare `{...}` object with `name` + `arguments`
 */

const REASONING_BLOCKS = [
  /<\|think\|>[\s\S]*?<\|\/think\|>/gi,
  /<thinking>[\s\S]*?<\/thinking>/gi,
  /<reasoning>[\s\S]*?<\/reasoning>/gi,
];

/** Remove `` style blocks / stray reasoning prefixes before speaking. */
export function stripReasoning(text: string | undefined | null): string {
  if (!text) return '';
  let out = text;
  for (const pattern of REASONING_BLOCKS) out = out.replace(pattern, ' ');
  // An unclosed opening block: drop everything after it (nothing speakable follows).
  out = out.replace(/<\|think\|>[\s\S]*$/i, ' ');
  out = out.replace(/^[\s]*(thought|reasoning)\s*:\s*[\s\S]*?(?=\n\n)/i, ' ');
  return out.replace(/[ \t]+\n/g, '\n').trim();
}

/** Fix the common non-JSON quirks local models emit, then parse or return null. */
export function tolerantJsonParse(raw: string): { value: unknown; coerced: boolean } | null {
  const attempts: string[] = [raw];
  let coerced = raw !== raw.trim();
  let text = raw.trim();

  const pythonFixed = text
    .replace(/:\s*None\b/g, ': null')
    .replace(/[,[]\s*None\b/g, (m) => `${m[0]} null`)
    .replace(/:\s*True\b/g, ': true')
    .replace(/:\s*False\b/g, ': false')
    .replace(/[,[]\s*True\b/g, (m) => `${m[0]} true`)
    .replace(/[,[]\s*False\b/g, (m) => `${m[0]} false`);
  if (pythonFixed !== text) {
    text = pythonFixed;
    coerced = true;
  }
  attempts.push(text);
  // Trailing commas before } or ] are a frequent slip.
  const commaFixed = text.replace(/,\s*([}\]])/g, '$1');
  if (commaFixed !== text) {
    attempts.push(commaFixed);
    coerced = true;
  }
  // Single-quoted dict style: only attempted as a last resort.
  if (/^\{.*\}$/.test(text) && /'/.test(text)) {
    attempts.push(text.replace(/'/g, '"'));
    coerced = true;
  }

  for (const attempt of attempts) {
    try {
      return { value: JSON.parse(attempt), coerced };
    } catch {
      // try next fix-up
    }
  }
  return null;
}

/** Balanced-brace scan that ignores braces inside strings. */
function topLevelObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}

/** `Record_Symptom`, `record-symptom`, `record symptom` -> `record_symptom`. */
function normalizeName(name: string): string {
  return name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s.-]+/g, '_')
    .toLowerCase();
}

interface ParsedShape {
  name?: string;
  arguments?: unknown;
  id?: unknown;
  function?: { name?: string; arguments?: unknown };
  tool?: { name?: string; arguments?: unknown };
}

function toToolCall(
  value: unknown,
  known: Set<string> | null,
  index: number,
  tier: ParseOutcome,
): { call?: ToolCall; coerced: boolean; rejected?: string } {
  let coerced = tier !== 'native';
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { coerced, rejected: 'tool call payload is not an object' };
  }
  const shape = value as ParsedShape;
  const rawName = shape.name ?? shape.function?.name ?? shape.tool?.name;
  if (typeof rawName !== 'string' || rawName.length === 0) {
    return { coerced, rejected: 'missing tool name' };
  }
  const name = normalizeName(rawName);
  if (name !== rawName) coerced = true;
  if (known !== null && !known.has(name)) {
    return { coerced, rejected: `unknown tool "${name}"` };
  }

  const rawArgs: unknown = shape.arguments ?? shape.function?.arguments ?? shape.tool?.arguments ?? {};
  let args: Record<string, unknown> = {};
  if (typeof rawArgs === 'string') {
    coerced = true;
    const trimmedArgs = rawArgs.trim();
    if (trimmedArgs.length === 0 || trimmedArgs === '{}' || trimmedArgs === '[]' || trimmedArgs === 'null') {
      args = {};
    } else {
      const parsed = tolerantJsonParse(trimmedArgs);
      if (parsed === null || typeof parsed.value !== 'object' || parsed.value === null) {
        return { coerced, rejected: `arguments string for "${name}" is not valid JSON` };
      }
      args = Array.isArray(parsed.value) ? {} : (parsed.value as Record<string, unknown>);
    }
  } else if (Array.isArray(rawArgs) || rawArgs === null || rawArgs === undefined) {
    coerced = true;
    args = {};
  } else if (typeof rawArgs === 'object') {
    args = rawArgs as Record<string, unknown>;
  } else {
    return { coerced, rejected: `arguments for "${name}" are not an object` };
  }

  const id =
    typeof shape.id === 'string' && shape.id.length > 0
      ? shape.id
      : `call_${tier}_${Date.now().toString(36)}_${index}`;
  return { call: { id, name, arguments: args }, coerced };
}

/** Flatten a parsed JSON payload (object, array, or `{tool_calls: [...]}`) into candidates. */
function candidatesFrom(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'object' && value !== null) {
    const nested = (value as { tool_calls?: unknown }).tool_calls;
    if (Array.isArray(nested)) return nested;
    const nestedCalls = (value as { calls?: unknown }).calls;
    if (Array.isArray(nestedCalls)) return nestedCalls;
    return [value];
  }
  return [];
}

export interface ParseInput {
  /** The raw `message.tool_calls` array from the provider, if present. */
  native?: unknown;
  /** Assistant text, scanned for inline / fenced / bare tool syntax. */
  text?: string;
  /** Whitelist of tool names; unknown names are rejected (and counted). */
  knownToolNames?: readonly string[];
}

export interface ParseResult {
  toolCalls: ToolCall[];
  tier: ParseOutcome;
  rejected: string[];
}

export function parseToolCallResponse(input: ParseInput): ParseResult {
  const known = input.knownToolNames ? new Set(input.knownToolNames) : null;

  const consume = (payload: unknown[], tier: ParseOutcome): ParseResult => {
    const toolCalls: ToolCall[] = [];
    const rejected: string[] = [];
    let coercions = 0;
    payload.forEach((item, index) => {
      const outcome = toToolCall(item, known, index, tier);
      if (outcome.coerced) coercions += 1;
      if (outcome.call) toolCalls.push(outcome.call);
      else if (outcome.rejected) rejected.push(outcome.rejected);
    });
    if (coercions > 0) recordCoercion(coercions);
    if (rejected.length > 0) recordRejected(rejected.length);
    if (toolCalls.length > 0) recordAccepted(toolCalls.length);
    recordTier(toolCalls.length > 0 ? tier : 'none', toolCalls.length > 0);
    return { toolCalls, tier: toolCalls.length > 0 ? tier : 'none', rejected };
  };

  // 1. native `tool_calls`
  if (Array.isArray(input.native) && input.native.length > 0) {
    return consume(input.native, 'native');
  }

  const text = input.text ?? '';
  if (text.trim().length === 0) return { toolCalls: [], tier: 'none', rejected: [] };

  let sawToolSyntax = false;     

  // 2. inline <tool_call> ... </tool_call> blocks
  const inline: unknown[] = [];
  for (const match of text.matchAll(/<tool_call\s*>([\s\S]*?)<\/tool_call\s*>/gi)) {
    sawToolSyntax = true;                       // ← new
    const body = match[1];
    if (!body) continue;
    const parsed = tolerantJsonParse(body);
    if (parsed) inline.push(...candidatesFrom(parsed.value));
  }
  if (inline.length > 0) return consume(inline, 'inline_tag');

  // 3. fenced ```json ... ``` blocks
  const fenced: unknown[] = [];
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const body = match[1];
    if (!body) continue;
    const parsed = tolerantJsonParse(body);
    if (parsed) fenced.push(...candidatesFrom(parsed.value));
  }
  if (fenced.length > 0) return consume(fenced, 'fenced_json');

  // 4. bare JSON object(s) carrying name + arguments
  const bare: unknown[] = [];
  for (const candidate of topLevelObjects(text)) {
    const parsed = tolerantJsonParse(candidate);
    if (parsed) bare.push(...candidatesFrom(parsed.value));
  }
  const usable = bare.filter((item) => {
    if (typeof item !== 'object' || item === null) return false;
    const shape = item as ParsedShape;
    return typeof (shape.name ?? shape.function?.name ?? shape.tool?.name) === 'string';
  });
  if (usable.length > 0) return consume(usable, 'bare_json');

  if (sawToolSyntax) recordTier('none', false);

  return { toolCalls: [], tier: 'none', rejected: [] };
}


