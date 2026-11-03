import { and, desc, eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import * as table from '../schema.js';
import { createDb, type Db } from '../client.js';
import type {
  CallRow,
  CallScriptRow,
  CallTurnRow,
  CallTurnsRepo,
  CallsRepo,
  CallScriptsRepo,
  DischargeDocumentRow,
  DischargeDocumentsRepo,
  EscalationRow,
  EscalationsRepo,
  ExtractionRow,
  ExtractionsRepo,
  FollowupRow,
  FollowupsRepo,
  OrganizationRow,
  OrganizationsRepo,
  PatientRow,
  PatientsRepo,
  Repositories,
} from './types.js';
import type { CallStatus, EscalationStatus, TurnRole } from '../schema.js';

/** Postgres implementation (Drizzle) used by the server. */
export { type Db };

class PgOrganizations implements OrganizationsRepo {
  constructor(private db: Db) {}

  async ensureByName(name: string): Promise<OrganizationRow> {
    const existing = await this.db.select().from(table.organizations).where(eq(table.organizations.name, name)).limit(1);
    if (existing[0]) return toOrganization(existing[0]);
    const [row] = await this.db
      .insert(table.organizations)
      .values({ id: randomUUID(), name })
      .returning();
    return toOrganization(row as unknown as OrganizationRecord);
  }

  async get(id: string): Promise<OrganizationRow | null> {
    const [row] = await this.db.select().from(table.organizations).where(eq(table.organizations.id, id)).limit(1);
    return row ? toOrganization(row as unknown as OrganizationRecord) : null;
  }
}

type OrganizationRecord = OrganizationRow;
function toOrganization(row: OrganizationRecord): OrganizationRow {
  return { ...row };
}

class PgPatients implements PatientsRepo {
  constructor(private db: Db) {}

  async create(input: Omit<PatientRow, 'id' | 'createdAt'>): Promise<PatientRow> {
    const [row] = await this.db
      .insert(table.patients)
      .values({ id: randomUUID(), ...input })
      .returning();
    return row as unknown as PatientRow;
  }

  async get(id: string): Promise<PatientRow | null> {
    const [row] = await this.db.select().from(table.patients).where(eq(table.patients.id, id)).limit(1);
    return row ? (row as unknown as PatientRow) : null;
  }

  async findByExternalRef(orgId: string, externalRef: string): Promise<PatientRow | null> {
    const [row] = await this.db
      .select()
      .from(table.patients)
      .where(and(eq(table.patients.orgId, orgId), eq(table.patients.externalRef, externalRef)))
      .limit(1);
    return row ? (row as unknown as PatientRow) : null;
  }

  async listByOrg(orgId: string, limit = 100): Promise<PatientRow[]> {
    const rows = await this.db
      .select()
      .from(table.patients)
      .where(eq(table.patients.orgId, orgId))
      .orderBy(table.patients.createdAt)
      .limit(limit);
    return rows as unknown as PatientRow[];
  }
}

class PgCallScripts implements CallScriptsRepo {
  constructor(private db: Db) {}

  async upsert(input: {
    orgId: string;
    name: string;
    version: number;
    yamlSource: string;
  }): Promise<CallScriptRow> {
    const [row] = await this.db
      .insert(table.callScripts)
      .values({ id: randomUUID(), ...input })
      .onConflictDoUpdate({
        target: [table.callScripts.orgId, table.callScripts.name, table.callScripts.version],
        set: { yamlSource: input.yamlSource },
      })
      .returning();
    return row as unknown as CallScriptRow;
  }

  async get(id: string): Promise<CallScriptRow | null> {
    const [row] = await this.db.select().from(table.callScripts).where(eq(table.callScripts.id, id)).limit(1);
    return row ? (row as unknown as CallScriptRow) : null;
  }

  async findByName(orgId: string, name: string): Promise<CallScriptRow | null> {
    const [row] = await this.db
      .select()
      .from(table.callScripts)
      .where(and(eq(table.callScripts.orgId, orgId), eq(table.callScripts.name, name)))
      .orderBy(desc(table.callScripts.version))
      .limit(1);
    return row ? (row as unknown as CallScriptRow) : null;
  }
}

class PgDischargeDocuments implements DischargeDocumentsRepo {
  constructor(private db: Db) {}

  async create(input: {
    patientId: string;
    sourceFilename: string;
    rawText: string;
    parsedJson: unknown;
  }): Promise<DischargeDocumentRow> {
    const [row] = await this.db.insert(table.dischargeDocuments).values({ id: randomUUID(), ...input }).returning();
    return row as unknown as DischargeDocumentRow;
  }

  async get(id: string): Promise<DischargeDocumentRow | null> {
    const [row] = await this.db
      .select()
      .from(table.dischargeDocuments)
      .where(eq(table.dischargeDocuments.id, id))
      .limit(1);
    return row ? (row as unknown as DischargeDocumentRow) : null;
  }

  async listByPatient(patientId: string): Promise<DischargeDocumentRow[]> {
    const rows = await this.db
      .select()
      .from(table.dischargeDocuments)
      .where(eq(table.dischargeDocuments.patientId, patientId))
      .orderBy(table.dischargeDocuments.createdAt);
    return rows as unknown as DischargeDocumentRow[];
  }
}

class PgCalls implements CallsRepo {
  constructor(private db: Db) {}

  async create(input: {
    patientId: string;
    callScriptId: string;
    twilioCallSid?: string | null;
    status?: CallStatus;
    startedAt?: Date | null;
  }): Promise<CallRow> {
    const [row] = await this.db
      .insert(table.calls)
      .values({
        id: randomUUID(),
        patientId: input.patientId,
        callScriptId: input.callScriptId,
        twilioCallSid: input.twilioCallSid ?? null,
        status: input.status ?? 'ringing',
        startedAt: input.startedAt ?? null,
      })
      .returning();
    return row as unknown as CallRow;
  }

  async get(id: string): Promise<CallRow | null> {
    const [row] = await this.db.select().from(table.calls).where(eq(table.calls.id, id)).limit(1);
    return row ? (row as unknown as CallRow) : null;
  }

  async getByTwilioCallSid(sid: string): Promise<CallRow | null> {
    const [row] = await this.db.select().from(table.calls).where(eq(table.calls.twilioCallSid, sid)).limit(1);
    return row ? (row as unknown as CallRow) : null;
  }

  async update(id: string, patch: Partial<Omit<CallRow, 'id' | 'createdAt'>>): Promise<CallRow | null> {
    const [row] = await this.db.update(table.calls).set(patch).where(eq(table.calls.id, id)).returning();
    return row ? (row as unknown as CallRow) : null;
  }

  async listRecent(limit = 20): Promise<CallRow[]> {
    const rows = await this.db.select().from(table.calls).orderBy(desc(table.calls.createdAt)).limit(limit);
    return rows as unknown as CallRow[];
  }

  async listByPatient(patientId: string, limit = 20): Promise<CallRow[]> {
    const rows = await this.db
      .select()
      .from(table.calls)
      .where(eq(table.calls.patientId, patientId))
      .orderBy(desc(table.calls.createdAt))
      .limit(limit);
    return rows as unknown as CallRow[];
  }
}

class PgCallTurns implements CallTurnsRepo {
  constructor(private db: Db) {}

  async append(input: {
    callId: string;
    idx: number;
    role: TurnRole;
    text: string;
    latencyMs?: number | null;
  }): Promise<CallTurnRow> {
    const [row] = await this.db
      .insert(table.callTurns)
      .values({ id: randomUUID(), ...input, latencyMs: input.latencyMs ?? null })
      .returning();
    return row as unknown as CallTurnRow;
  }

  async listByCall(callId: string): Promise<CallTurnRow[]> {
    const rows = await this.db
      .select()
      .from(table.callTurns)
      .where(eq(table.callTurns.callId, callId))
      .orderBy(table.callTurns.idx);
    return rows as unknown as CallTurnRow[];
  }
}

class PgExtractions implements ExtractionsRepo {
  constructor(private db: Db) {}

  async append(input: {
    callId: string;
    field: string;
    value: unknown;
    confidence?: number | null;
  }): Promise<ExtractionRow> {
    const [row] = await this.db
      .insert(table.extractions)
      .values({ id: randomUUID(), ...input, confidence: input.confidence ?? null })
      .returning();
    return row as unknown as ExtractionRow;
  }

  async appendMany(
    inputs: Array<{ callId: string; field: string; value: unknown; confidence?: number | null }>,
  ): Promise<ExtractionRow[]> {
    if (inputs.length === 0) return [];
    const rows = await this.db
      .insert(table.extractions)
      .values(inputs.map((input) => ({ id: randomUUID(), ...input, confidence: input.confidence ?? null })))
      .returning();
    return rows as unknown as ExtractionRow[];
  }

  async listByCall(callId: string): Promise<ExtractionRow[]> {
    const rows = await this.db
      .select()
      .from(table.extractions)
      .where(eq(table.extractions.callId, callId))
      .orderBy(table.extractions.createdAt);
    return rows as unknown as ExtractionRow[];
  }
}

class PgEscalations implements EscalationsRepo {
  constructor(private db: Db) {}

  async append(input: {
    callId: string;
    ruleId: string;
    reason: string;
    urgency: 'routine' | 'urgent' | 'emergent';
    status?: EscalationStatus;
  }): Promise<EscalationRow> {
    const [row] = await this.db
      .insert(table.escalations)
      .values({ id: randomUUID(), ...input, status: input.status ?? 'open' })
      .returning();
    return row as unknown as EscalationRow;
  }

  async listByCall(callId: string): Promise<EscalationRow[]> {
    const rows = await this.db
      .select()
      .from(table.escalations)
      .where(eq(table.escalations.callId, callId))
      .orderBy(table.escalations.createdAt);
    return rows as unknown as EscalationRow[];
  }

  async listOpen(limit = 50): Promise<EscalationRow[]> {
    const rows = await this.db
      .select()
      .from(table.escalations)
      .where(eq(table.escalations.status, 'open'))
      .orderBy(desc(table.escalations.createdAt))
      .limit(limit);
    return rows as unknown as EscalationRow[];
  }

  async setStatus(id: string, status: EscalationStatus): Promise<EscalationRow | null> {
    const [row] = await this.db
      .update(table.escalations)
      .set({ status })
      .where(eq(table.escalations.id, id))
      .returning();
    return row ? (row as unknown as EscalationRow) : null;
  }
}

class PgFollowups implements FollowupsRepo {
  constructor(private db: Db) {}

  async append(input: {
    callId: string;
    scheduledFor: Date;
    reason: string;
    status?: EscalationStatus;
  }): Promise<FollowupRow> {
    const [row] = await this.db
      .insert(table.followupCallbacks)
      .values({ id: randomUUID(), ...input, status: input.status ?? 'open' })
      .returning();
    return row as unknown as FollowupRow;
  }

  async listByCall(callId: string): Promise<FollowupRow[]> {
    const rows = await this.db
      .select()
      .from(table.followupCallbacks)
      .where(eq(table.followupCallbacks.callId, callId))
      .orderBy(table.followupCallbacks.scheduledFor);
    return rows as unknown as FollowupRow[];
  }
}

export function createPostgresRepositories(databaseUrl: string): Repositories & { pool: Pool } {
  const { db, pool } = createDb(databaseUrl);
  return {
    pool,
    organizations: new PgOrganizations(db),
    patients: new PgPatients(db),
    callScripts: new PgCallScripts(db),
    dischargeDocuments: new PgDischargeDocuments(db),
    calls: new PgCalls(db),
    callTurns: new PgCallTurns(db),
    extractions: new PgExtractions(db),
    escalations: new PgEscalations(db),
    followups: new PgFollowups(db),
    async close(): Promise<void> {
      await pool.end();
    },
  };
}


