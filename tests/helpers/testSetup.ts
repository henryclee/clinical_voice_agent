/**
 * Shared test wiring. Everything runs with the scripted mock model and in-memory
 * repositories, so `npm test` needs no database and no vendor credentials.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { noopLogger } from '../../src/common/logger.js';
import { loadDefaultCallScript, parseCallScript, type LoadedCallScript } from '../../src/config/loadCallScript.js';
import { loadEnv, type AppEnv } from '../../src/config/env.js';
import { bootstrapReferenceData } from '../../src/db/bootstrap.js';
import { createInMemoryRepositories, type InMemoryRepositories } from '../../src/db/repositories/memory.js';
import { createNotifier } from '../../src/escalation/notify.js';
import { MockLlmClient, type MockResponse, type ScriptedStepReply } from '../../src/llm/mockClient.js';
import type { ToolCall } from '../../src/llm/types.js';
import { Orchestrator } from '../../src/orchestrator/Orchestrator.js';
import { buildApp, type BuiltApp } from '../../src/server/app.js';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Env for tests: required vars fall back to dev defaults, `.env` is ignored, and every
 * vendor credential is forced off so HTTP tests stay text-only and hermetic.
 */
export function testEnv(overrides: Partial<AppEnv> = {}): AppEnv {
  const base = loadEnv({ requireRequired: false, skipDotenv: true });
  return {
    ...base,
    mockLlm: true,
    twilio: null,
    elevenlabs: null,
    deepgramApiKey: null,
    textOnly: true,
    escalationWebhookUrl: null,
    ...overrides,
  };
}

export function defaultScript(): LoadedCallScript {
  return loadDefaultCallScript(REPO_ROOT);
}

/** Inline YAML script, for tests that need a bespoke step list. */
export function scriptFromYaml(yamlText: string): LoadedCallScript {
  return parseCallScript(yamlText, 'test-inline-script');
}

/** Shape `toContext()` expects on `dischargeDocuments.parsedJson`. */
export const TEST_DISCHARGE_PARSED = {
  primary_diagnosis: 'Cellulitis of the left lower leg',
  procedures: [],
  medications: [{ name: 'Cephalexin', dosage: '500mg', frequency: 'QID', duration: '7 days' }],
  follow_up: { provider: 'Dr. Okafor', reason: 'wound check', timeframe: '3 days' },
  red_flags: ['Fever above 100.4F', 'Spreading redness'],
  discharge_date: '2026-10-28',
};

export interface HarnessOptions {
  script?: LoadedCallScript;
  env?: AppEnv;
  /** Mock mode; 'scripted' drives steps from the shipped script, 'replay' uses `responses`. */
  mode?: 'echo' | 'replay' | 'scripted';
  responses?: MockResponse[];
  stepScript?: ScriptedStepReply[];
  structured?: unknown[];
  maxTurns?: number;
}

export interface Harness {
  env: AppEnv;
  script: LoadedCallScript;
  repos: InMemoryRepositories;
  llm: MockLlmClient;
  orchestrator: Orchestrator;
  patientId: string;
}

/** Repos + one seeded synthetic patient + orchestrator wired to the deterministic mock. */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const env = options.env ?? testEnv();
  const script = options.script ?? defaultScript();
  const repos = createInMemoryRepositories();
  await bootstrapReferenceData(repos, script, env.practiceName);
  const org = await repos.organizations.ensureByName(env.practiceName);
  const patient = await repos.patients.create({
    orgId: org.id,
    externalRef: 'synthetic-001',
    firstName: 'AVA',
    lastName: 'NAKAMURA',
    dob: '1984-03-12',
    phone: '+15550001111',
  });
  await repos.dischargeDocuments.create({
    patientId: patient.id,
    sourceFilename: 'synthetic_discharge.md',
    rawText: '# Discharge Summary\nPrimary Diagnosis: Cellulitis of the left lower leg\n',
    parsedJson: TEST_DISCHARGE_PARSED,
  });

  const llm = new MockLlmClient({
    mode: options.mode ?? 'scripted',
    responses: options.responses,
    script: options.stepScript,
    structured: options.structured,
    logger: noopLogger,
  });
  const notifier = createNotifier({ escalations: repos.escalations, logger: noopLogger });
  const orchestrator = new Orchestrator({
    llm,
    repos,
    script,
    practiceName: env.practiceName,
    notifier,
    logger: noopLogger,
    maxTurns: options.maxTurns,
  });

  return { env, script, repos, llm, orchestrator, patientId: patient.id };
}

/** HTTP surface over in-memory repos + mock model. */
export async function createTestApp(options: HarnessOptions = {}): Promise<{ app: BuiltApp; harness: Harness }> {
  const harness = await createHarness(options);
  const app = await buildApp({
    env: harness.env,
    repos: harness.repos,
    repositoriesKind: 'memory',
    llm: harness.llm,
    script: harness.script,
  });
  return { app, harness };
}

/** Build a provider-shaped tool call (what `parseToolCallResponse` consumes). */
export function toolCallJson(name: string, args: Record<string, unknown>, id = 'call_1'): Record<string, unknown> {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

/** A native ChatCompletion-shaped tool call for the mock client's `toolCalls` field. */
export function nativeToolCall(name: string, args: Record<string, unknown>, id = `call_${name}`): ToolCall {
  return { id, name, arguments: args };
}
