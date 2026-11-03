import type { Prf, SetScore, FieldOutcome } from './metrics.js';
import type { JudgeVerdict } from './judge.js';
import type { ToolCallStats } from '../llm/stats.js';

/** One scenario's evaluated result (serialised to evals/.cache/). */
export interface ScenarioResult {
  id: string;
  title: string;
  pass: boolean;
  failures: string[];
  outcome: string | null;
  expectedOutcome: string;
  extraction: { fields: FieldOutcome[]; prf: Prf };
  escalation: SetScore;
  steps: SetScore;
  latencyMs: number[];
  p50Ms: number | null;
  p95Ms: number | null;
  latencyLabel: 'text-mode' | 'live-audio';
  judge: JudgeVerdict | null;
  transcript: { role: string; text: string }[];
}

export interface EvalRunSummary {
  generatedAt: string;
  mode: 'mock' | 'real';
  judged: boolean;
  model: string;
  endpoint: string;
  judgeModel: string;
  scenarioCount: number;
  passed: number;
  failed: number;
  extractionF1: number | null;
  escalationF1: number | null;
  stepAdherence: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  latencyLabel: string;
  judgeMean: number | null;
  toolCallStats: ToolCallStats;
  results: ScenarioResult[];
}
