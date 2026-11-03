import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { EvalRunSummary, ScenarioResult } from './types.js';

const pct = (value: number | null): string => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`);
const ms = (value: number | null): string => (value === null ? 'n/a' : `${Math.round(value)} ms`);

/** Markdown report + machine-readable ground-truth index. */
export function writeReport(summary: EvalRunSummary, outDir = process.cwd()): string {
  const lines: string[] = [];
  lines.push('# Eval results');
  lines.push('');
  lines.push(`Generated: ${summary.generatedAt}`);
  lines.push(`Mode: **${summary.mode}**${summary.mode === 'mock' ? ' — plumbing check only; these numbers are NOT model quality (the mock is handed the ground truth)' : ''}`);
  lines.push(`LLM: \`${summary.model}\` @ ${summary.endpoint}`);
  lines.push(`Judge: ${summary.judged ? `\`${summary.judgeModel}\`` : 'disabled (pass --judge)'}`);
  lines.push('');
  lines.push('## Aggregate');
  lines.push('');
  lines.push('| metric | value |');
  lines.push('| --- | --- |');
  lines.push(`| scenarios | ${summary.scenarioCount} (${summary.passed} pass / ${summary.failed} fail) |`);
  lines.push(`| extraction F1 (per field) | ${pct(summary.extractionF1)} |`);
  lines.push(`| escalation F1 | ${pct(summary.escalationF1)} |`);
  lines.push(`| step adherence | ${pct(summary.stepAdherence)} |`);
  lines.push(`| latency p50 | ${ms(summary.p50Ms)} (${summary.latencyLabel}) |`);
  lines.push(`| latency p95 | ${ms(summary.p95Ms)} (${summary.latencyLabel}) |`);
  lines.push(`| judge mean (1-5) | ${summary.judgeMean === null ? 'not judged' : summary.judgeMean.toFixed(2)} |`);
  lines.push('');
  lines.push('## Tool-call parser');
  lines.push('');
  lines.push('| metric | value |');
  lines.push('| --- | --- |');
  lines.push(`| native tool_calls | ${summary.toolCallStats.tiers.native} |`);
  lines.push(`| inline <tool_call> | ${summary.toolCallStats.tiers.inline_tag} |`);
  lines.push(`| fenced JSON | ${summary.toolCallStats.tiers.fenced_json} |`);
  lines.push(`| bare JSON | ${summary.toolCallStats.tiers.bare_json} |`);
  lines.push(`| coerced quirks | ${summary.toolCallStats.coercions} |`);
  lines.push(`| rejected calls | ${summary.toolCallStats.calls_rejected} |`);
  lines.push(
    `\`response_format\` fallbacks | ${summary.toolCallStats.param_fallback.response_format} |`,
  );
  lines.push(`\`tools\` fallbacks | ${summary.toolCallStats.param_fallback.tools} |`);
  lines.push('');
  lines.push('> Parser counters are module-global, so with `--concurrency > 1` they are a');
  lines.push('> per-run aggregate, not a per-scenario measurement.');
  lines.push('');
  lines.push('## Per scenario');
  lines.push('');
  lines.push('| id | pass | outcome | extraction F1 | escalation F1 | steps | p95 | judge |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const result of summary.results) {
    lines.push(
      `| ${result.id} | ${result.pass ? 'pass' : 'FAIL'} | ${result.outcome ?? 'none'} (want ${result.expectedOutcome}) | ${pct(
        result.extraction.prf.f1,
      )} | ${pct(result.escalation.f1)} | ${result.steps.tp}/${result.steps.expected.length} | ${ms(result.p95Ms)} | ${
        result.judge ? result.judge.safety.toFixed(0) : '-'
      } |`,
    );
  }
  lines.push('');
  const failures = summary.results.filter((result) => !result.pass);
  if (failures.length > 0) {
    lines.push('## Failures');
    lines.push('');
    for (const failure of failures) {
      lines.push(`### ${failure.id} — ${failure.title}`);
      for (const issue of failure.failures) lines.push(`- ${issue}`);
      lines.push('');
    }
  }

  mkdirSync(outDir, { recursive: true });
  const reportPath = path.join(outDir, 'eval-results.md');
  writeFileSync(reportPath, `${lines.join('\n')}\n`, 'utf8');
  return reportPath;
}

/** Machine-readable ground truth index (canonical ClinicalFields names only). */
export function writeGroundTruthIndex(
  results: readonly ScenarioResult[],
  outDir = path.join(process.cwd(), 'evals'),
): string {
  mkdirSync(path.join(outDir, 'ground_truth'), { recursive: true });
  const index = results.map((result) => ({
    id: result.id,
    expected_extractions: Object.fromEntries(result.extraction.fields.map((f) => [f.field, f.expected])),
    expected_escalations: result.escalation.expected,
    expected_steps: result.steps.expected,
    expected_outcome: result.expectedOutcome,
  }));
  const target = path.join(outDir, 'ground_truth', 'index.json');
  writeFileSync(target, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  return target;
}
