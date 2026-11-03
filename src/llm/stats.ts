/**
 * Module-global parser counters.
 *
 * IMPORTANT: these are *module-global*, so `toolCallStats()` is a per-run aggregate,
 * not a per-scenario measurement. The eval harness resets them before each run and,
 * under `--concurrency > 1`, the reported tool-call validity rate mixes scenarios.
 * Documented here and in BUILD_REPORT.md so nobody reads it as per-scenario truth.
 */
export const TOOL_CALL_TIERS = ['native', 'inline_tag', 'fenced_json', 'bare_json'] as const;
export type ToolCallTier = (typeof TOOL_CALL_TIERS)[number];
export type ParseOutcome = ToolCallTier | 'none';

export interface ToolCallStats {
  /** How many parse attempts resolved through each tier. */
  tiers: Record<ToolCallTier, number>;
  /** Responses that yielded at least one usable tool call. */
  responses_parsed: number;
  /** Responses that mentioned tool syntax but yielded nothing usable. */
  responses_failed: number;
  /** Individual tool calls accepted. */
  calls_accepted: number;
  /** Individual tool calls rejected (unknown name / unparseable arguments). */
  calls_rejected: number;
  /** Quirks fixed by coercion (Python literals, stringified args, name drift). */
  coercions: number;
  /** How often a vendor-incompatible parameter had to be dropped and the call retried. */
  param_fallback: { response_format: number; tools: number };
}

function freshStats(): ToolCallStats {
  return {
    tiers: { native: 0, inline_tag: 0, fenced_json: 0, bare_json: 0 },
    responses_parsed: 0,
    responses_failed: 0,
    calls_accepted: 0,
    calls_rejected: 0,
    coercions: 0,
    param_fallback: { response_format: 0, tools: 0 },
  };
}

let stats: ToolCallStats = freshStats();

export function resetToolCallStats(): void {
  stats = freshStats();
}

export function toolCallStats(): ToolCallStats {
  return {
    tiers: { ...stats.tiers },
    responses_parsed: stats.responses_parsed,
    responses_failed: stats.responses_failed,
    calls_accepted: stats.calls_accepted,
    calls_rejected: stats.calls_rejected,
    coercions: stats.coercions,
    param_fallback: { ...stats.param_fallback },
  };
}

export function recordTier(tier: ParseOutcome, parsed: boolean): void {
  if (tier === 'none') {
    stats.responses_failed += 1;
    return;
  }
  stats.tiers[tier] += 1;
  if (parsed) stats.responses_parsed += 1;
}

export function recordCoercion(count = 1): void {
  stats.coercions += count;
}

export function recordAccepted(count = 1): void {
  stats.calls_accepted += count;
}

export function recordRejected(count = 1): void {
  stats.calls_rejected += count;
}

export function recordParamFallback(param: 'response_format' | 'tools'): void {
  stats.param_fallback[param] += 1;
}

/** Accepted / (accepted + rejected) — null when nothing was attempted. */
export function toolCallValidityRate(current: ToolCallStats = toolCallStats()): number | null {
  const total = current.calls_accepted + current.calls_rejected;
  if (total === 0) return null;
  return current.calls_accepted / total;
}
