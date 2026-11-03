import type { LoadedCallScript } from '../config/loadCallScript.js';
import type { AppEnv } from '../config/env.js';
import { loadEnv } from '../config/env.js';
import { loadDefaultCallScript } from '../config/loadCallScript.js';
import { createLogger, type AppLogger } from '../common/logger.js';
import { MockLlmClient } from '../llm/mockClient.js';
import { OpenAiCompatClient } from '../llm/openaiClient.js';
import type { LlmClient } from '../llm/types.js';
import { createNotifier, type Notifier } from '../escalation/notify.js';
import { Orchestrator } from '../orchestrator/Orchestrator.js';
import { createRepositories, type RepositoriesKind } from '../db/index.js';
import type { Repositories } from '../db/repositories/types.js';
import { bootstrapReferenceData } from '../db/bootstrap.js';

/** Everything the HTTP surface needs, injectable so tests never touch infra. */
export interface AppDeps {
  env: AppEnv;
  logger: AppLogger;
  repos: Repositories;
  repositoriesKind: RepositoriesKind;
  llm: LlmClient;
  notifier: Notifier;
  orchestrator: Orchestrator;
  script: LoadedCallScript;
  ready: Promise<{ orgId: string; scriptRowId: string }>;
}

export interface BuildDepsOptions {
  env?: AppEnv;
  repos?: Repositories;
  repositoriesKind?: RepositoriesKind;
  llm?: LlmClient;
  script?: LoadedCallScript;
  baseDir?: string;
}

export async function buildDeps(options: BuildDepsOptions = {}): Promise<AppDeps> {
  const env = options.env ?? loadEnv({ cwd: options.baseDir });
  const logger = createLogger({ level: env.logLevel, name: 'server' });
  const repositoriesKind: RepositoriesKind =
    options.repositoriesKind ?? (options.repos ? 'memory' : 'postgres');
  const repos = options.repos ?? createRepositories({ kind: repositoriesKind, databaseUrl: env.databaseUrl });
  const script = options.script ?? loadDefaultCallScript(options.baseDir ?? process.cwd());

  const llm =
    options.llm ??
    (env.mockLlm
      ? new MockLlmClient({ mode: 'scripted', logger })
      : new OpenAiCompatClient({
          baseUrl: env.llm.baseUrl,
          apiKey: env.llm.apiKey,
          model: env.llm.model,
          logger,
        }));

  if (!options.llm && env.mockLlm) logger.warn('MOCK_LLM=true — the agent is scripted, not a real model');
  if (env.textOnly) {
    logger.warn('no voice-provider credentials found — running in TEXT-ONLY mode (REST + WebSocket)');
  }

  const notifier = createNotifier({
    escalations: repos.escalations,
    logger,
    webhookUrl: env.escalationWebhookUrl,
  });

  const orchestrator = new Orchestrator({
    llm,
    repos,
    script,
    practiceName: env.practiceName,
    notifier,
    logger,
  });

  const ready = bootstrapReferenceData(repos, script, env.practiceName);

  return { env, logger, repos, repositoriesKind, llm, notifier, orchestrator, script, ready };
}
