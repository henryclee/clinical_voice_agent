import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../common/logger.js';
import { loadEnv } from '../config/env.js';
import { loadDefaultCallScript, type LoadedCallScript } from '../config/loadCallScript.js';
import { bootstrapReferenceData } from '../db/bootstrap.js';
import { createInMemoryRepositories } from '../db/repositories/memory.js';
import { parseDischargeMarkdown } from '../extraction/dischargeParser.js';
import { createNotifier } from '../escalation/notify.js';
import { MockLlmClient } from '../llm/mockClient.js';
import { OpenAiCompatClient } from '../llm/openaiClient.js';
import { resetToolCallStats, toolCallStats } from '../llm/stats.js';
import { Orchestrator, type TurnResult } from '../orchestrator/Orchestrator.js';
import { judgeCall } from './judge.js';
import { mean, percentile, scoreExtractions, scoreSets, stepAdherence } from './metrics.js';
import { writeGroundTruthIndex, writeReport } from './reporter.js';
import { loadScenarios, mockScriptFor, type Scenario } from './scenarios.js';
import type { EvalRunSummary, ScenarioResult } from './types.js';

/**
 * `npm run eval -- --mock | --real [--concurrency n] [--judge] [--force]`
 *
 * --mock  scripted agent + in-memory repos: validates orchestration, escalation,
 *         persistence and metric math. Never a measure of model quality.
 * --real  the omlx endpoint (P1) drives every turn; only these numbers belong in the
 *         README headline table.
 */

export interface RunOptions {
  mode: 'mock' | 'real';
  concurrency: number;
  judge: boolean;
  /** Ignore the evals/.cache resume cache. */
  force: boolean;
  cwd?: string;
}

export interface EvalEndpoints {
  baseUrl: string;
  model: string;
  apiKey: string;
  judgeBaseUrl: string;
  judgeModel: string;
}

export function parseArgs(argv: string[]): RunOptions {
  const options: RunOptions = { mode: 'mock', concurrency: 1, judge: false, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--mock') options.mode = 'mock';
    if (arg === '--real') options.mode = 'real';
    if (arg === '--judge') options.judge = true;
    if (arg === '--force') options.force = true;
    if (arg === '--concurrency') {
      options.concurrency = Math.max(1, Number.parseInt(argv[index + 1] ?? '1', 10) || 1);
    }
  }
  return options;
}

async function runScenario(
  scenario: Scenario,
  options: RunOptions,
  script: LoadedCallScript,
  practiceName: string,
  endpoints: EvalEndpoints,
): Promise<ScenarioResult> {
  const logger = createLogger({ level: 'error', name: `eval:${scenario.id}` });
  const repos = createInMemoryRepositories();
  const { orgId } = await bootstrapReferenceData(repos, script, practiceName);
  const patient = await repos.patients.create({
    orgId,
    externalRef: scenario.patient.externalRef,
    firstName: scenario.patient.firstName,
    lastName: scenario.patient.lastName,
    dob: scenario.patient.dob,
    phone: scenario.patient.phone,
  });

  const docSource = path.join(options.cwd ?? process.cwd(), 'evals', scenario.discharge_doc);
  const rawDoc = existsSync(docSource) ? readFileSync(docSource, 'utf8') : '';
  const parsedDoc = rawDoc
    ? parseDischargeMarkdown(rawDoc, path.basename(docSource))
    : {
        patient_name: `${patient.firstName} ${patient.lastName}`,
        discharge_date: '',
        primary_diagnosis: 'unspecified',
        medications: [],
        follow_up: { provider: '', reason: '' },
        red_flags: [],
        procedures: [],
      };
  await repos.dischargeDocuments.create({
    patientId: patient.id,
    sourceFilename: path.basename(docSource),
    rawText: rawDoc || '(fixture document missing)',
    parsedJson: parsedDoc,
  });

  const llm =
    options.mode === 'mock'
      ? new MockLlmClient({ mode: 'scripted', script: mockScriptFor(scenario), logger })
      : new OpenAiCompatClient({
          baseUrl: endpoints.baseUrl,
          apiKey: endpoints.apiKey,
          model: endpoints.model,
          logger,
        });

  const orchestrator = new Orchestrator({
    llm,
    repos,
    script,
    practiceName,
    notifier: createNotifier({ escalations: repos.escalations, logger }),
    logger,
    maxTurns: Math.max(10, scenario.patient_turns.length + 3),
  });

  const turns: TurnResult[] = [];
  const first = await orchestrator.start({ patientId: patient.id });
  turns.push(first);
  let callEnded = first.callEnded;
  for (const utterance of scenario.patient_turns) {
    if (callEnded) break;
    const turn = await orchestrator.turn(first.callId, utterance);
    turns.push(turn);
    callEnded = turn.callEnded;
  }
  if (!callEnded) {
    await orchestrator.end(first.callId, 'partial').catch(() => undefined);
  }

  const [escalationRows, finalCall] = await Promise.all([
    repos.escalations.listByCall(first.callId),
    repos.calls.get(first.callId),
  ]);
  await repos.close();

  const completedSteps = turns.filter((turn) => turn.stepAdvanced).map((turn) => turn.stepId ?? '');
  const lastFields = (turns[turns.length - 1]?.fields ?? {}) as unknown as Record<string, unknown>;

  const extraction = scoreExtractions(scenario.expected.extractions as Record<string, unknown>, lastFields);
  const escalation = scoreSets(
    scenario.expected.escalations,
    escalationRows.map((row) => row.ruleId),
  );
  const steps = stepAdherence(scenario.expected.required_steps_completed, completedSteps);
  const latencies = turns.map((turn) => turn.latencyMs);

  const failures: string[] = [];
  if ((finalCall?.outcome ?? null) !== scenario.expected.outcome) {
    failures.push(`outcome ${finalCall?.outcome ?? 'null'} != expected ${scenario.expected.outcome}`);
  }
  for (const field of extraction.fields) {
    if (!field.correct) {
      failures.push(
        `field ${field.field}: expected ${JSON.stringify(field.expected)}, got ${JSON.stringify(field.actual)}`,
      );
    }
  }
  if (!escalation.exact) {
    failures.push(`escalations: missing [${escalation.missing.join(', ')}] spurious [${escalation.spurious.join(', ')}]`);
  }
  if (steps.missing.length > 0) failures.push(`steps not completed: ${steps.missing.join(', ')}`);

  const judgeLlm =
    options.judge && options.mode === 'real'
      ? new OpenAiCompatClient({
          baseUrl: endpoints.judgeBaseUrl,
          apiKey: endpoints.apiKey,
          model: endpoints.judgeModel,
          logger,
        })
      : null;
  const judge = judgeLlm
    ? await judgeCall(judgeLlm, {
        transcript: turns.map((turn) => ({ role: 'agent', text: turn.agentUtterance })),
        persona: script.script.persona,
        escalations: escalationRows.map((row) => ({ ruleId: row.ruleId, urgency: row.urgency })),
      })
    : null;

  return {
    id: scenario.id,
    title: scenario.title,
    pass: failures.length === 0,
    failures,
    outcome: finalCall?.outcome ?? null,
    expectedOutcome: scenario.expected.outcome,
    extraction: { fields: extraction.fields, prf: extraction.prf },
    escalation,
    steps,
    latencyMs: latencies,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    latencyLabel: 'text-mode',
    judge,
    transcript: turns.map((turn) => ({ role: 'agent', text: turn.agentUtterance })),
  };
}

export async function runEvals(options: RunOptions): Promise<EvalRunSummary> {
  const cwd = options.cwd ?? process.cwd();
  const env = loadEnv({ cwd, requireRequired: options.mode === 'real' });
  const logger = createLogger({ level: 'info', name: 'evals' });
  const script = loadDefaultCallScript(cwd);
  const scenarios = loadScenarios(path.join(cwd, 'evals', 'scenarios'));

  resetToolCallStats();
  const cacheDir = path.join(cwd, 'evals', '.cache');
  mkdirSync(cacheDir, { recursive: true });

  const results: ScenarioResult[] = [];
  const queue = [...scenarios];
  const workerCount = Math.max(1, Math.min(options.concurrency, queue.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const scenario = queue.shift();
      if (!scenario) return;
      const cachePath = path.join(cacheDir, `${scenario.id}.json`);
      if (!options.force && existsSync(cachePath)) {
        try {
          results.push(JSON.parse(readFileSync(cachePath, 'utf8')) as ScenarioResult);
          logger.info({ scenario: scenario.id }, 'cache hit');
          continue;
        } catch {
          // corrupt cache entry: recompute below
        }
      }
      const result = await runScenario(scenario, { ...options, cwd }, script, env.practiceName, {
        baseUrl: env.llm.baseUrl,
        model: env.llm.model,
        apiKey: env.llm.apiKey,
        judgeBaseUrl: env.judge.baseUrl,
        judgeModel: env.judge.model,
      });
      results.push(result);
      writeFileSync(cachePath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
      logger.info({ scenario: scenario.id, pass: result.pass }, 'scenario complete');
    }
  });
  await Promise.all(workers);
  results.sort((a, b) => a.id.localeCompare(b.id));

  const allLatencies = results.flatMap((result) => result.latencyMs);
  const verdicts = results.map((result) => result.judge).filter((verdict) => verdict !== null);
  const summary: EvalRunSummary = {
    generatedAt: new Date().toISOString(),
    mode: options.mode,
    judged: options.judge,
    model: options.mode === 'mock' ? 'mock(scripted)' : env.llm.model,
    endpoint: options.mode === 'mock' ? 'in-process' : env.llm.baseUrl,
    judgeModel: env.judge.model,
    scenarioCount: results.length,
    passed: results.filter((result) => result.pass).length,
    failed: results.filter((result) => !result.pass).length,
    extractionF1: mean(results.map((result) => result.extraction.prf.f1)),
    escalationF1: mean(results.map((result) => result.escalation.f1)),
    stepAdherence: mean(
      // Recall over required steps: a call may legitimately clear more steps than a
      // scenario names (early refusal scenarios list only what must have happened),
      // and 130% adherence is meaningless, so extra steps neither help nor hurt.
      results.map((result) => result.steps.recall),
    ),
    p50Ms: percentile(allLatencies, 50),
    p95Ms: percentile(allLatencies, 95),
    latencyLabel: 'text-mode (audio pipeline not measured)',
    judgeMean:
      verdicts.length === 0
        ? null
        : mean(verdicts.map((verdict) => (verdict.tone + verdict.instruction_following + verdict.safety) / 3)),
    toolCallStats: toolCallStats(),
    results,
  };

  const reportPath = writeReport(summary, cwd);
  const groundTruthPath = writeGroundTruthIndex(results, path.join(cwd, 'evals'));
  logger.info(
    { reportPath, groundTruthPath, passed: summary.passed, failed: summary.failed },
    'eval run complete',
  );
  return summary;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const options = parseArgs(process.argv.slice(2));
  runEvals(options)
    .then((summary) => {
      console.log(
        `\n${summary.mode.toUpperCase()} eval: ${summary.passed}/${summary.scenarioCount} scenarios passed ` +
          `(extraction F1 ${((summary.extractionF1 ?? 0) * 100).toFixed(1)}%, ` +
          `escalation F1 ${((summary.escalationF1 ?? 0) * 100).toFixed(1)}%, ` +
          `step adherence ${((summary.stepAdherence ?? 0) * 100).toFixed(1)}%)`,
      );
      if (summary.mode === 'mock') {
        console.log('NOTE: mock numbers validate plumbing only — they are NOT model-quality results.');
      }
      process.exit(summary.failed === 0 ? 0 : 1);
    })
    .catch((error: unknown) => {
      console.error('eval run failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    });
}


