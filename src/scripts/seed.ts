import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../common/logger.js';
import { loadEnv } from '../config/env.js';
import { loadDefaultCallScript } from '../config/loadCallScript.js';
import { bootstrapReferenceData } from '../db/bootstrap.js';
import { createRepositories, type RepositoriesKind } from '../db/index.js';
import { parseDischargeMarkdown } from '../extraction/dischargeParser.js';
import { SYNTHETIC_PATIENTS } from './fixtures.js';

/**
 * `npm run db:seed` — idempotent seed of SYNTHETIC patients + their discharge documents.
 * Safe to re-run: patients are matched by external ref, docs are appended (newest wins).
 */
export async function seed(options: { cwd?: string; kind?: RepositoriesKind } = {}): Promise<{
  orgId: string;
  scriptRowId: string;
  patients: number;
  documents: number;
}> {
  const cwd = options.cwd ?? process.cwd();
  const env = loadEnv({ cwd });
  const logger = createLogger({ level: env.logLevel, name: 'seed' });
  const kind: RepositoriesKind = options.kind ?? 'postgres';
  const repos = createRepositories({ kind, databaseUrl: env.databaseUrl });

  try {
    const script = loadDefaultCallScript(cwd);
    const { orgId, scriptRowId } = await bootstrapReferenceData(repos, script, env.practiceName);

    let patients = 0;
    let documents = 0;
    for (const fixture of SYNTHETIC_PATIENTS) {
      const existing = await repos.patients.findByExternalRef(orgId, fixture.externalRef);
      const patient =
        existing ??
        (await repos.patients.create({
          orgId,
          externalRef: fixture.externalRef,
          firstName: fixture.firstName,
          lastName: fixture.lastName,
          dob: fixture.dob,
          phone: fixture.phone,
        }));
      patients += 1;

      const absolute = path.join(cwd, fixture.dischargeDoc);
      const raw = readFileSync(absolute, 'utf8');
      const parsed = parseDischargeMarkdown(raw, path.basename(absolute));
      await repos.dischargeDocuments.create({
        patientId: patient.id,
        sourceFilename: path.basename(absolute),
        rawText: raw,
        parsedJson: parsed,
      });
      documents += 1;
      logger.info({ patient: `${patient.firstName} ${patient.lastName}`, ref: fixture.externalRef }, 'seeded');
    }

    logger.info({ orgId, scriptRowId, patients, documents }, 'seed complete');
    return { orgId, scriptRowId, patients, documents };
  } finally {
    await repos.close();
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  await seed().catch((error: unknown) => {
    console.error('seed failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
