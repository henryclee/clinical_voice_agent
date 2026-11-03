import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuildDepsOptions } from './deps.js';
import { buildDeps, type AppDeps } from './deps.js';
import { registerRoutes } from './routes.js';
import { attachMediaStream, attachTextSocket } from './mediaStream.js';

export interface BuiltApp {
  app: FastifyInstance;
  deps: AppDeps;
}

/** App factory — tests inject in-memory repos + mock LLM and never touch infra. */
export async function buildApp(options: BuildDepsOptions = {}): Promise<BuiltApp> {
  const deps = await buildDeps(options);
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });

  registerRoutes(app, deps);

  const publicDir = path.join(options.baseDir ?? process.cwd(), 'public');
  if (existsSync(publicDir)) {
    await app.register(fastifyStatic, { root: publicDir, prefix: '/' });
  }

  app.addHook('onClose', async () => {
    await deps.repos.close();
  });

  await app.ready();
  return { app, deps };
}

export async function startServer(options: BuildDepsOptions = {}): Promise<{ app: FastifyInstance; deps: AppDeps }> {
  const { app, deps } = await buildApp(options);
  attachMediaStream(app.server, deps);
  attachTextSocket(app.server, deps);

  await app.listen({ port: deps.env.port, host: deps.env.host });
  deps.logger.info(
    {
      port: deps.env.port,
      llm: deps.llm.kind,
      repositories: deps.repositoriesKind,
      textOnly: deps.env.textOnly,
      script: deps.script.script.id,
    },
    'clinical_voice_agent listening',
  );
  if (deps.env.textOnly) {
    deps.logger.warn('text-only mode: open http://localhost:%d/ for the browser demo, or use the REST endpoints', deps.env.port);
  }
  return { app, deps };
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  startServer().catch((error: unknown) => {
    console.error('server failed to start:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
