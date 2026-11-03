import { date, index, integer, jsonb, pgTable, real, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * Data model. SYNTHETIC DATA ONLY — every row this project writes in demos, tests and
 * evals is fictional.
 *
 * `calls.status`  = telephony lifecycle (Twilio status callbacks) — never set by the model.
 * `calls.outcome` = agent logic (completed | partial | refused | escalated).
 */

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const callScripts = pgTable(
  'call_scripts',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    version: integer('version').notNull(),
    yamlSource: text('yaml_source').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('call_scripts_org_name_version_idx').on(t.orgId, t.name, t.version)],
);

export const patients = pgTable(
  'patients',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    externalRef: text('external_ref').notNull(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    dob: date('dob').notNull(),
    phone: text('phone').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('patients_org_ref_idx').on(t.orgId, t.externalRef),
    index('patients_org_idx').on(t.orgId),
  ],
);

export const dischargeDocuments = pgTable(
  'discharge_documents',
  {
    id: uuid('id').primaryKey(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'cascade' }),
    sourceFilename: text('source_filename').notNull(),
    rawText: text('raw_text').notNull(),
    parsedJson: jsonb('parsed_json').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('discharge_docs_patient_idx').on(t.patientId)],
);

export const CALL_STATUSES = ['ringing', 'in_progress', 'completed', 'failed', 'no_answer'] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

export const CALL_OUTCOMES = ['completed', 'partial', 'refused', 'escalated'] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

export const calls = pgTable(
  'calls',
  {
    id: uuid('id').primaryKey(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'cascade' }),
    callScriptId: uuid('call_script_id')
      .notNull()
      .references(() => callScripts.id, { onDelete: 'restrict' }),
    /** UNIQUE — makes Twilio status-callback replay idempotent. */
    twilioCallSid: text('twilio_call_sid'),
    status: text('status').$type<CallStatus>().notNull().default('ringing'),
    outcome: text('outcome').$type<CallOutcome | null>(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    summaryText: text('summary_text'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('calls_twilio_sid_idx').on(t.twilioCallSid),
    index('calls_patient_idx').on(t.patientId),
    index('calls_created_idx').on(t.createdAt),
  ],
);

export const TURN_ROLES = ['agent', 'patient', 'system'] as const;
export type TurnRole = (typeof TURN_ROLES)[number];

export const callTurns = pgTable(
  'call_turns',
  {
    id: uuid('id').primaryKey(),
    callId: uuid('call_id')
      .notNull()
      .references(() => calls.id, { onDelete: 'cascade' }),
    idx: integer('idx').notNull(),
    role: text('role').$type<TurnRole>().notNull(),
    text: text('text').notNull(),
    /** Per-turn latency; text-mode replays record LLM wall time and label it as such. */
    latencyMs: integer('latency_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('call_turns_call_idx').on(t.callId, t.idx)],
);

export const extractions = pgTable(
  'extractions',
  {
    id: uuid('id').primaryKey(),
    callId: uuid('call_id')
      .notNull()
      .references(() => calls.id, { onDelete: 'cascade' }),
    /** Canonical ClinicalFields name, or a namespaced tool value e.g. `vital:spo2`. */
    field: text('field').notNull(),
    value: jsonb('value').notNull(),
    confidence: real('confidence'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('extractions_call_idx').on(t.callId, t.field)],
);

export const ESCALATION_STATUSES = ['open', 'acknowledged', 'resolved'] as const;
export type EscalationStatus = (typeof ESCALATION_STATUSES)[number];

export const escalations = pgTable(
  'escalations',
  {
    id: uuid('id').primaryKey(),
    callId: uuid('call_id')
      .notNull()
      .references(() => calls.id, { onDelete: 'cascade' }),
    ruleId: text('rule_id').notNull(),
    reason: text('reason').notNull(),
    urgency: text('urgency').$type<'routine' | 'urgent' | 'emergent'>().notNull(),
    status: text('status').$type<EscalationStatus>().notNull().default('open'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('escalations_call_idx').on(t.callId), index('escalations_status_idx').on(t.status)],
);

export const followupCallbacks = pgTable(
  'followup_callbacks',
  {
    id: uuid('id').primaryKey(),
    callId: uuid('call_id')
      .notNull()
      .references(() => calls.id, { onDelete: 'cascade' }),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull(),
    reason: text('reason').notNull(),
    status: text('status').$type<EscalationStatus>().notNull().default('open'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('followups_call_idx').on(t.callId),
    index('followups_due_idx').on(t.scheduledFor, t.status),
  ],
);

