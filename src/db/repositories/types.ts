import type {
  CallOutcome,
  CallStatus,
  EscalationStatus,
  TurnRole,
} from '../schema.js';

/**
 * Repository contracts. Two implementations:
 *   - Postgres (drizzle) — used by the server
 *   - In-memory        — used by unit tests and the eval harness, so `npm test` and
 *     `npm run eval -- --mock` never require a database.
 *
 * The orchestrator depends on these interfaces only.
 */

export interface OrganizationRow {
  id: string;
  name: string;
  createdAt: Date;
}

export interface PatientRow {
  id: string;
  orgId: string;
  externalRef: string;
  firstName: string;
  lastName: string;
  /** ISO yyyy-mm-dd */
  dob: string;
  phone: string;
  createdAt: Date;
}

export interface CallScriptRow {
  id: string;
  orgId: string;
  name: string;
  version: number;
  yamlSource: string;
  createdAt: Date;
}

export interface DischargeDocumentRow {
  id: string;
  patientId: string;
  sourceFilename: string;
  rawText: string;
  parsedJson: unknown;
  createdAt: Date;
}

export interface CallRow {
  id: string;
  patientId: string;
  callScriptId: string;
  twilioCallSid: string | null;
  status: CallStatus;
  outcome: CallOutcome | null;
  startedAt: Date | null;
  endedAt: Date | null;
  summaryText: string | null;
  createdAt: Date;
}

export interface CallTurnRow {
  id: string;
  callId: string;
  idx: number;
  role: TurnRole;
  text: string;
  latencyMs: number | null;
  createdAt: Date;
}

export interface ExtractionRow {
  id: string;
  callId: string;
  field: string;
  value: unknown;
  confidence: number | null;
  createdAt: Date;
}

export interface EscalationRow {
  id: string;
  callId: string;
  ruleId: string;
  reason: string;
  urgency: 'routine' | 'urgent' | 'emergent';
  status: EscalationStatus;
  createdAt: Date;
}

export interface FollowupRow {
  id: string;
  callId: string;
  scheduledFor: Date;
  reason: string;
  status: EscalationStatus;
  createdAt: Date;
}

export interface OrganizationsRepo {
  ensureByName(name: string): Promise<OrganizationRow>;
  get(id: string): Promise<OrganizationRow | null>;
}

export interface PatientsRepo {
  create(input: Omit<PatientRow, 'id' | 'createdAt'>): Promise<PatientRow>;
  get(id: string): Promise<PatientRow | null>;
  findByExternalRef(orgId: string, externalRef: string): Promise<PatientRow | null>;
  listByOrg(orgId: string, limit?: number): Promise<PatientRow[]>;
}

export interface CallScriptsRepo {
  upsert(input: { orgId: string; name: string; version: number; yamlSource: string }): Promise<CallScriptRow>;
  get(id: string): Promise<CallScriptRow | null>;
  findByName(orgId: string, name: string): Promise<CallScriptRow | null>;
}

export interface DischargeDocumentsRepo {
  create(input: {
    patientId: string;
    sourceFilename: string;
    rawText: string;
    parsedJson: unknown;
  }): Promise<DischargeDocumentRow>;
  get(id: string): Promise<DischargeDocumentRow | null>;
  listByPatient(patientId: string): Promise<DischargeDocumentRow[]>;
}

export interface CallsRepo {
  create(input: {
    patientId: string;
    callScriptId: string;
    twilioCallSid?: string | null;
    status?: CallStatus;
    startedAt?: Date | null;
  }): Promise<CallRow>;
  get(id: string): Promise<CallRow | null>;
  getByTwilioCallSid(sid: string): Promise<CallRow | null>;
  update(id: string, patch: Partial<Omit<CallRow, 'id' | 'createdAt'>>): Promise<CallRow | null>;
  listRecent(limit?: number): Promise<CallRow[]>;
  listByPatient(patientId: string, limit?: number): Promise<CallRow[]>;
}

export interface CallTurnsRepo {
  append(input: { callId: string; idx: number; role: TurnRole; text: string; latencyMs?: number | null }): Promise<CallTurnRow>;
  listByCall(callId: string): Promise<CallTurnRow[]>;
}

export interface ExtractionsRepo {
  append(input: { callId: string; field: string; value: unknown; confidence?: number | null }): Promise<ExtractionRow>;
  appendMany(inputs: Array<{ callId: string; field: string; value: unknown; confidence?: number | null }>): Promise<ExtractionRow[]>;
  listByCall(callId: string): Promise<ExtractionRow[]>;
}

export interface EscalationsRepo {
  append(input: {
    callId: string;
    ruleId: string;
    reason: string;
    urgency: 'routine' | 'urgent' | 'emergent';
    status?: EscalationStatus;
  }): Promise<EscalationRow>;
  listByCall(callId: string): Promise<EscalationRow[]>;
  listOpen(limit?: number): Promise<EscalationRow[]>;
  setStatus(id: string, status: EscalationStatus): Promise<EscalationRow | null>;
}

export interface FollowupsRepo {
  append(input: { callId: string; scheduledFor: Date; reason: string; status?: EscalationStatus }): Promise<FollowupRow>;
  listByCall(callId: string): Promise<FollowupRow[]>;
}

export interface Repositories {
  organizations: OrganizationsRepo;
  patients: PatientsRepo;
  callScripts: CallScriptsRepo;
  dischargeDocuments: DischargeDocumentsRepo;
  calls: CallsRepo;
  callTurns: CallTurnsRepo;
  extractions: ExtractionsRepo;
  escalations: EscalationsRepo;
  followups: FollowupsRepo;
  close(): Promise<void>;
}
