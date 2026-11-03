import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../common/logger.js';
import { loadEnv } from '../config/env.js';
import { loadDefaultCallScript } from '../config/loadCallScript.js';
import { bootstrapReferenceData } from '../db/bootstrap.js';
import { createInMemoryRepositories } from '../db/repositories/memory.js';
import { parseDischargeMarkdown } from '../extraction/dischargeParser.js';
import { createNotifier } from '../escalation/notify.js';
import { actionFor } from '../escalation/engine.js';
import { MockLlmClient } from '../llm/mockClient.js';
import { OpenAiCompatClient } from '../llm/openaiClient.js';
import { Orchestrator } from '../orchestrator/Orchestrator.js';
import { percentile } from '../transport/AudioTransport.js';
import { TextTransport } from '../transport/TextTransport.js';
import { mockScriptFor, type Scenario } from '../eval/scenarios.js';

/**
 * `npm run demo` — keyboard role-play through the REAL orchestrator over TextTransport.
 *
 * With MOCK_LLM=true (or --mock) a scripted agent replies: that proves the plumbing
 * (state machine, escalation, persistence) without a GPU. Without it every turn goes to
 * the configured OpenAI-compatible endpoint, and the run prints a disclaimer because
 * nothing here was measured over real audio.
 */

const DEMO_DOC = 'evals/discharge_docs/d01_cellulitis.md';

const USAGE = [
  'during the call:',
  '  /end or /quit   hang up and print the summary',
  '  /status         current step, outcome and escalations',
].join('\n');

const DEMO_SCENARIO: Scenario = {
  id: 'demo',
  title: 'interactive demo',
  discharge_doc: DEMO_DOC,
  patient: { externalRef: 'SYN-DEMO', firstName: 'Jordan', lastName: 'Ellis', dob: '1968-04-12', phone: '+15550001001' },
  patient_turns: [],
  mock_end_call_at: 'wrap_up',
  expected: {
    extractions: {
      identity_verified: true,
      pain_score: 2,
      chest_pain: false,
      shortness_of_breath: 'none',
      medication_adherent: true,
      followup_confirmed: true,
    },
    escalations: [],
    required_steps_completed: [],
    outcome: 'completed',
  },
  notes: 'mock script used by the interactive demo',
};

export interface DemoOptions {
  mock: boolean;
  cwd?: string;
}

export function parseDemoArgs(argv: string[]): DemoOptions {
  return { mock: argv.includes('--mock') };
}

export async function runDemo(options: DemoOptions = { mock: false }): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  let mock = options.mock;
  let env;
  try {
    env = loadEnv({ cwd, requireRequired: false });
  } catch {
    env = null;
  }
  mock = mock || (env?.mockLlm ?? false);
  if (!mock && (!env || !env.llm.baseUrl || !env.llm.model)) {
    console.error('demo needs LLM_BASE_URL/LLM_MODEL/LLM_API_KEY, or run with --mock for the scripted agent.');
    process.exit(1);
  }
  const resolvedEnv = env as NonNullable<typeof env>;

  const logger = createLogger({ level: mock ? 'error' : 'info', name: 'demo' });
  const script = loadDefaultCallScript(cwd);
  const repos = createInMemoryRepositories();
  const { orgId } = await bootstrapReferenceData(repos, script, resolvedEnv.practiceName);

  const patient = await repos.patients.create({
    orgId,
    externalRef: DEMO_SCENARIO.patient.externalRef,
    firstName: DEMO_SCENARIO.patient.firstName,
    lastName: DEMO_SCENARIO.patient.lastName,
    dob: DEMO_SCENARIO.patient.dob,
    phone: DEMO_SCENARIO.patient.phone,
  });

  const docPath = path.join(cwd, DEMO_DOC);
  const rawDoc = existsSync(docPath) ? readFileSync(docPath, 'utf8') : '';
  await repos.dischargeDocuments.create({
    patientId: patient.id,
    sourceFilename: path.basename(docPath),
    rawText: rawDoc || '(discharge fixture missing)',
    parsedJson: rawDoc
      ? parseDischargeMarkdown(rawDoc, path.basename(docPath))
      : {
          patient_name: 'Jordan Ellis',
          discharge_date: '',
          primary_diagnosis: 'unspecified',
          medications: [],
          follow_up: { provider: '', reason: '' },
          red_flags: [],
          procedures: [],
        },
  });

  const llm = mock
    ? new MockLlmClient({ mode: 'scripted', script: mockScriptFor(DEMO_SCENARIO), logger })
    : new OpenAiCompatClient({
        baseUrl: resolvedEnv.llm.baseUrl,
        apiKey: resolvedEnv.llm.apiKey,
        model: resolvedEnv.llm.model,
        logger,
      });

  const orchestrator = new Orchestrator({
    llm,
    repos,
    script,
    practiceName: resolvedEnv.practiceName,
    notifier: createNotifier({ escalations: repos.escalations, logger, webhookUrl: resolvedEnv.escalationWebhookUrl }),
    logger,
  });
  const transport = new TextTransport((line) => console.log(`\nAGENT: ${line}`));

  console.log('='.repeat(72));
  console.log(
    `clinical_voice_agent demo — ${
      mock ? 'MOCK agent (plumbing check only)' : `LLM ${resolvedEnv.llm.model} @ ${resolvedEnv.llm.baseUrl}`
    }`,
  );
  console.log(`script ${script.script.id}@${script.script.version} · patient Jordan Ellis (SYNTHETIC)`);
  console.log(USAGE);
  console.log('='.repeat(72));

  const first = await orchestrator.start({ patientId: patient.id });
  await transport.speak(first.agentUtterance);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let ended = first.callEnded;
  let lastStep = first.stepId;
  let lastOutcome = first.outcome;
  while (!ended) {
    const line = (await rl.question('\nYOU  : ')).trim();
    if (line.length === 0) continue;
    if (line === '/end' || line === '/quit') {
      await orchestrator.end(first.callId, 'refused').catch(() => undefined);
      break;
    }
    if (line === '/status') {
      const escalations = await repos.escalations.listByCall(first.callId);
      console.log(
        `step: ${lastStep ?? 'n/a'} · outcome: ${lastOutcome ?? 'open'} · escalations: ${
          escalations.map((e) => `${e.ruleId}/${e.urgency}`).join(', ') || 'none'
        }`,
      );
      continue;
    }
    const turn = await orchestrator.turn(first.callId, line);
    lastStep = turn.stepId ?? lastStep;
    lastOutcome = turn.outcome ?? lastOutcome;
    await transport.speak(turn.agentUtterance);
    for (const decision of turn.escalations) {
      console.log(`  [escalation] ${decision.ruleId} (${decision.urgency}) -> ${actionFor(decision)}`);
    }
    ended = turn.callEnded;
  }
  rl.close();

  const summary = await orchestrator.summary(first.callId);
  const latencies = summary.transcript.map((turn) => turn.latencyMs).filter((value): value is number => value !== null);
  console.log('\n' + '-'.repeat(72));
  console.log(`outcome: ${summary.outcome ?? 'none'} · turns: ${summary.transcript.length}`);
  console.log('canonical fields:');
  for (const [field, value] of Object.entries(summary.fields)) {
    if (value === null || value === undefined) continue;
    console.log(`  ${field} = ${JSON.stringify(value)}`);
  }
  for (const step of summary.missingRequired) console.log(`  missing required step: ${step}`);
  console.log(`  escalations: ${summary.staff.escalations.map((e) => `${e.rule_id}/${e.urgency}`).join(', ') || 'none'}`);
  console.log(`  ${summary.summaryText}`);
  console.log(`  latency p50 ${Math.round(percentile(latencies, 50) ?? 0)} ms · p95 ${Math.round(percentile(latencies, 95) ?? 0)} ms (text mode)`);
  console.log(
    mock
      ? '\nNOTE: MOCK mode — the scripted agent was handed the answers. Not model quality.'
      : '\nNOTE: keyboard role-play over TextTransport. Not measured over real audio.',
  );

  await transport.close('demo complete');
  await repos.close();
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  runDemo(parseDemoArgs(process.argv.slice(2))).catch((error: unknown) => {
    console.error('demo failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

