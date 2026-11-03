import { randomUUID } from 'node:crypto';
import type { CallStatus, EscalationStatus, TurnRole } from '../schema.js';
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

/**
 * In-memory repositories: the same contracts as the Postgres implementation, with no
 * infrastructure. Unit tests and the eval harness run against these, which is what makes
 * `npm test` and `npm run eval -- --mock` work with Docker stopped (P0 acceptance).
 */

interface Store {
  organizations: OrganizationRow[];
  patients: PatientRow[];
  callScripts: CallScriptRow[];
  dischargeDocuments: DischargeDocumentRow[];
  calls: CallRow[];
  callTurns: CallTurnRow[];
  extractions: ExtractionRow[];
  escalations: EscalationRow[];
  followups: FollowupRow[];
}

function createStore(): Store {
  return {
    organizations: [],
    patients: [],
    callScripts: [],
    dischargeDocuments: [],
    calls: [],
    callTurns: [],
    extractions: [],
    escalations: [],
    followups: [],
  };
}

function isoAsc(a: { createdAt: Date }, b: { createdAt: Date }): number {
  return a.createdAt.getTime() - b.createdAt.getTime();
}

class MemoryOrganizations implements OrganizationsRepo {
  constructor(private store: Store) {}

  async ensureByName(name: string): Promise<OrganizationRow> {
    const existing = this.store.organizations.find((row) => row.name === name);
    if (existing) return existing;
    const row: OrganizationRow = { id: randomUUID(), name, createdAt: new Date() };
    this.store.organizations.push(row);
    return row;
  }

  async get(id: string): Promise<OrganizationRow | null> {
    return this.store.organizations.find((r) => r.id === id) ?? null;
  }
}

class MemoryPatients implements PatientsRepo {
  constructor(private store: Store) {}

  async create(input: Omit<PatientRow, 'id' | 'createdAt'>): Promise<PatientRow> {
    const row: PatientRow = { ...input, id: randomUUID(), createdAt: new Date() };
    this.store.patients.push(row);
    return row;
  }

  async get(id: string): Promise<PatientRow | null> {
    return this.store.patients.find((r) => r.id === id) ?? null;
  }

  async findByExternalRef(orgId: string, externalRef: string): Promise<PatientRow | null> {
    return this.store.patients.find((r) => r.orgId === orgId && r.externalRef === externalRef) ?? null;
  }

  async listByOrg(orgId: string, limit = 100): Promise<PatientRow[]> {
    return this.store.patients.filter((r) => r.orgId === orgId).sort(isoAsc).slice(0, limit);
  }
}

class MemoryCallScripts implements CallScriptsRepo {
  constructor(private store: Store) {}

  async upsert(input: {
    orgId: string;
    name: string;
    version: number;
    yamlSource: string;
  }): Promise<CallScriptRow> {
    const existing = this.store.callScripts.find(
      (r) => r.orgId === input.orgId && r.name === input.name && r.version === input.version,
    );
    if (existing) {
      existing.yamlSource = input.yamlSource;
      return existing;
    }
    const row: CallScriptRow = { id: randomUUID(), ...input, createdAt: new Date() };
    this.store.callScripts.push(row);
    return row;
  }

  async get(id: string): Promise<CallScriptRow | null> {
    return this.store.callScripts.find((r) => r.id === id) ?? null;
  }

  async findByName(orgId: string, name: string): Promise<CallScriptRow | null> {
    const matches = this.store.callScripts
      .filter((r) => r.orgId === orgId && r.name === name)
      .sort((a, b) => b.version - a.version);
    return matches[0] ?? null;
  }
}

class MemoryDischargeDocuments implements DischargeDocumentsRepo {
  constructor(private store: Store) {}

  async create(input: {
    patientId: string;
    sourceFilename: string;
    rawText: string;
    parsedJson: unknown;
  }): Promise<DischargeDocumentRow> {
    const row: DischargeDocumentRow = { id: randomUUID(), ...input, createdAt: new Date() };
    this.store.dischargeDocuments.push(row);
    return row;
  }

  async get(id: string): Promise<DischargeDocumentRow | null> {
    return this.store.dischargeDocuments.find((r) => r.id === id) ?? null;
  }

  async listByPatient(patientId: string): Promise<DischargeDocumentRow[]> {
    return this.store.dischargeDocuments.filter((r) => r.patientId === patientId).sort(isoAsc);
  }
}

class MemoryCalls implements CallsRepo {
  constructor(private store: Store) {}

  async create(input: {
    patientId: string;
    callScriptId: string;
    twilioCallSid?: string | null;
    status?: CallStatus;
    startedAt?: Date | null;
  }): Promise<CallRow> {
    const row: CallRow = {
      id: randomUUID(),
      patientId: input.patientId,
      callScriptId: input.callScriptId,
      twilioCallSid: input.twilioCallSid ?? null,
      status: input.status ?? 'ringing',
      outcome: null,
      startedAt: input.startedAt ?? null,
      endedAt: null,
      summaryText: null,
      createdAt: new Date(),
    };
    this.store.calls.push(row);
    return row;
  }

  async get(id: string): Promise<CallRow | null> {
    return this.store.calls.find((r) => r.id === id) ?? null;
  }

  async getByTwilioCallSid(sid: string): Promise<CallRow | null> {
    return this.store.calls.find((r) => r.twilioCallSid === sid) ?? null;
  }

  async update(id: string, patch: Partial<Omit<CallRow, 'id' | 'createdAt'>>): Promise<CallRow | null> {
    const row = this.store.calls.find((r) => r.id === id);
    if (!row) return null;
    Object.assign(row, patch);
    return row;
  }

  async listRecent(limit = 20): Promise<CallRow[]> {
    return [...this.store.calls].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, limit);
  }

  async listByPatient(patientId: string, limit = 20): Promise<CallRow[]> {
    return this.store.calls.filter((r) => r.patientId === patientId).slice(-limit);
  }
}

class MemoryCallTurns implements CallTurnsRepo {
  constructor(private store: Store) {}

  async append(input: {
    callId: string;
    idx: number;
    role: TurnRole;
    text: string;
    latencyMs?: number | null;
  }): Promise<CallTurnRow> {
    const row: CallTurnRow = {
      id: randomUUID(),
      callId: input.callId,
      idx: input.idx,
      role: input.role,
      text: input.text,
      latencyMs: input.latencyMs ?? null,
      createdAt: new Date(),
    };
    this.store.callTurns.push(row);
    return row;
  }

  async listByCall(callId: string): Promise<CallTurnRow[]> {
    return this.store.callTurns.filter((r) => r.callId === callId).sort((a, b) => a.idx - b.idx);
  }
}

class MemoryExtractions implements ExtractionsRepo {
  constructor(private store: Store) {}

  async append(input: {
    callId: string;
    field: string;
    value: unknown;
    confidence?: number | null;
  }): Promise<ExtractionRow> {
    const row: ExtractionRow = {
      id: randomUUID(),
      callId: input.callId,
      field: input.field,
      value: input.value,
      confidence: input.confidence ?? null,
      createdAt: new Date(),
    };
    this.store.extractions.push(row);
    return row;
  }

  async appendMany(
    inputs: Array<{ callId: string; field: string; value: unknown; confidence?: number | null }>,
  ): Promise<ExtractionRow[]> {
    return Promise.all(inputs.map((input) => this.append(input)));
  }

  async listByCall(callId: string): Promise<ExtractionRow[]> {
    return this.store.extractions.filter((r) => r.callId === callId);
  }
}

class MemoryEscalations implements EscalationsRepo {
  constructor(private store: Store) {}

  async append(input: {
    callId: string;
    ruleId: string;
    reason: string;
    urgency: 'routine' | 'urgent' | 'emergent';
    status?: EscalationStatus;
  }): Promise<EscalationRow> {
    const row: EscalationRow = {
      id: randomUUID(),
      callId: input.callId,
      ruleId: input.ruleId,
      reason: input.reason,
      urgency: input.urgency,
      status: input.status ?? 'open',
      createdAt: new Date(),
    };
    this.store.escalations.push(row);
    return row;
  }

  async listByCall(callId: string): Promise<EscalationRow[]> {
    return this.store.escalations.filter((r) => r.callId === callId);
  }

  async listOpen(limit = 50): Promise<EscalationRow[]> {
    return this.store.escalations.filter((r) => r.status === 'open').slice(0, limit);
  }

  async setStatus(id: string, status: EscalationStatus): Promise<EscalationRow | null> {
    const row = this.store.escalations.find((r) => r.id === id);
    if (!row) return null;
    row.status = status;
    return row;
  }
}

class MemoryFollowups implements FollowupsRepo {
  constructor(private store: Store) {}

  async append(input: {
    callId: string;
    scheduledFor: Date;
    reason: string;
    status?: EscalationStatus;
  }): Promise<FollowupRow> {
    const row: FollowupRow = {
      id: randomUUID(),
      callId: input.callId,
      scheduledFor: input.scheduledFor,
      reason: input.reason,
      status: input.status ?? 'open',
      createdAt: new Date(),
    };
    this.store.followups.push(row);
    return row;
  }

  async listByCall(callId: string): Promise<FollowupRow[]> {
    return this.store.followups.filter((r) => r.callId === callId);
  }
}

export interface InMemoryRepositories extends Repositories {
  /** Test helper: wipe all rows in place (repositories keep their store reference). */
  reset(): void;
  /** Direct access for assertions. */
  readonly store: Store;
}

export function createInMemoryRepositories(): InMemoryRepositories {
  const store = createStore();
  return {
    store,
    organizations: new MemoryOrganizations(store),
    patients: new MemoryPatients(store),
    callScripts: new MemoryCallScripts(store),
    dischargeDocuments: new MemoryDischargeDocuments(store),
    calls: new MemoryCalls(store),
    callTurns: new MemoryCallTurns(store),
    extractions: new MemoryExtractions(store),
    escalations: new MemoryEscalations(store),
    followups: new MemoryFollowups(store),
    async close(): Promise<void> {
      // nothing to release
    },
    reset(): void {
      for (const key of Object.keys(store) as (keyof Store)[]) {
        (store[key] as unknown[]).length = 0;
      }
    },
  };
}

export type { Store as InMemoryStore };


