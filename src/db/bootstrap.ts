import { loadEnv } from '../config/env.js';
import type { LoadedCallScript } from '../config/loadCallScript.js';
import type { Repositories } from './repositories/types.js';

/**
 * Idempotent reference-data bootstrap: org + the active call script. Called on server
 * boot and by the seed script, so a fresh database is usable immediately.
 */
export async function bootstrapReferenceData(
  repos: Repositories,
  script: LoadedCallScript,
  practiceName: string = loadEnv({ requireRequired: false, skipDotenv: true }).practiceName,
): Promise<{ orgId: string; scriptRowId: string }> {
  const org = await repos.organizations.ensureByName(practiceName);
  const scriptRow = await repos.callScripts.upsert({
    orgId: org.id,
    name: script.script.id,
    version: script.script.version,
    yamlSource: script.source,
  });
  return { orgId: org.id, scriptRowId: scriptRow.id };
}
