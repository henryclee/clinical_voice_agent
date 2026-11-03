# Plan: Clinical Voice Agent — Post-Discharge Follow-Up

> **Rev 2 (2026-11-02)** — post-review revision. Key changes: pnpm → **npm**; local LLM pinned
> to **omlx** (`http://localhost:8080/v1`, model `Qwen3.8-Flash-Next-oQ4e-mtp`, API key required —
> confirmed live); git repo initialized manually by the user. Added: required-vs-optional env split,
> tiered Definition of Done (P0/P1/P2), canonical `ClinicalFields` schema, rule + escalation-action
> semantics, Twilio voice/status-callback routes and SDK stance, scripted barge-in test, in-memory
> repositories for tests/evals, mock-vs-real metrics semantics, docker-compose for Postgres, config
> files in the layout, Deepgram Aura fallback payload, judge-model env vars, seed script.
> Decisions marked **(decision)** — flag any you disagree with. Rev 1 is at `/tmp/PLAN.rev1.bak`.

## What we're building

A production-shaped prototype of a real-time AI voice agent that calls patients after
hospital discharge, asks configurable follow-up questions, extracts structured clinical
context from the conversation, generates staff-facing summaries, and escalates per
rule-based safety logic. It ships with an evaluation harness that scores call-flow
adherence, extraction accuracy, escalation precision/recall, and per-turn latency.

The product shape:
- A **call script** (YAML) defines the ordered steps, prompts, and escalation rules for
  a call type. Today there is one: `post_discharge_followup`.
- A **state machine** drives the call through those steps. An LLM generates each
  utterance and extracts clinical fields from what the patient said.
- A **discharge document parser** turns a synthetic discharge summary into structured
  patient context (meds, follow-up, red flags) that seeds the call.
- An **escalation engine** re-evaluates extracted fields against the rules after every
  turn and is the source of truth for when a human needs to be looped in. The model
  proposes; rules decide.
- A **transport layer** carries audio. `TextTransport` powers tests and evals;
  `TwilioTransport` (or a browser WebSocket fallback) carries real calls.
- An **eval harness** replays 15 scripted patient personas through the orchestrator and
  produces a metrics table in `eval-results.md`.

This is a portfolio project. Optimize for clean architecture, readable code, tests, and
an eval suite that proves the safety behavior — not for scale.

Hard constraints:
- **No PHI. Ever.** All patients, discharge documents, and transcripts are synthetic.
  Put a `SYNTHETIC DATA ONLY` note in the README and in every fixture file header.
- Node 22+, TypeScript `strict: true`, ESM, **npm** (npm 10.9.3 ships with the installed
  Node 22.18; pnpm is not installed on this machine — do not use it).
- Do not invent third-party API shapes. If unsure about a Twilio / Deepgram /
  ElevenLabs payload, check the reference section at the end, then the vendor docs,
  then ask. Known exception: omlx's native `tools` / `response_format` support varies
  by version — treat both as best-effort behind the tool-call tolerance layer, never
  load-bearing.
- **Git:** the user will `git init` manually. Where no repo exists yet, skip commit
  steps and record the intended conventional-commit messages in `BUILD_REPORT.md`;
  once the repo exists, commit after each module.

## Credentials & readiness checklist

- **P0 — no credentials** *(verified 2026-11-02: Node v22.18.0, npm 10.9.3, Docker daemon
  running)*: Modules A–E run fully via `--mock` + in-memory repositories.
- **P1 — local model, no cloud keys**: omlx serving `Qwen3.8-Flash-Next-oQ4e-mtp` at
  `http://localhost:8080/v1` *(confirmed live; it enforces an API key — set `LLM_API_KEY`
  to the key omlx was started with)*. Verify with
  `curl -s -H "Authorization: Bearer $LLM_API_KEY" localhost:8080/v1/models`.
  Needed for `--real` evals, LLM-as-judge, and the live-call agent.
- **P2 — cloud keys + public tunnel**: Twilio `ACCOUNT_SID`/`AUTH_TOKEN`/`FROM_NUMBER`,
  `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID`, and a public
  HTTPS/WSS tunnel for Twilio voice + media webhooks (`ngrok http 3000` or
  `cloudflared tunnel --url http://localhost:3000`) exported as `PUBLIC_HOST`.
- Missing P2 never blocks P0/P1 — see tiered Definition of Done.

## Execution model

Build the entire project in one continuous run. Do not stop for approval between
modules. After each module: typecheck, run tests, fix up to 3 attempts, then stub with
a documented TODO and continue. Write `BUILD_REPORT.md` at the end.

Never block the build on a third-party service. If a dependency is unavailable —
including omlx itself — stub it behind its interface, finish the build, and record the
integration steps in `BUILD_REPORT.md`.
## Stack

- HTTP/WS: Fastify ^5 + `ws` ^8 (raw WebSocket server for Twilio Media Streams)
- DB: PostgreSQL 16 via `docker-compose.yml` (image `postgres:16-alpine`, volume-persisted,
  port 5432) + Drizzle ORM + drizzle-kit migrations; driver `pg` (+ `@types/pg`)
- Validation: Zod `^3.23` at every external boundary (config, LLM tool args, LLM
  extraction, HTTP) + `zod-to-json-schema` to compile tool definitions into the JSON
  Schema that OpenAI-style `tools` requires. Pin zod@3 for converter maturity.
- LLM: OpenAI-compatible client (`openai` npm package) pointed at **omlx**:
  `LLM_BASE_URL` defaults to `http://localhost:8080/v1`, `LLM_MODEL` defaults to
  `Qwen3.8-Flash-Next-oQ4e-mtp`, `LLM_API_KEY` is required by omlx (no sane default —
  fail fast with a hint if unset). Structured outputs via
  `response_format: {type: "json_object"}` plus a Zod schema; tool calling via the
  standard `tools` field. If omlx rejects `response_format` or `tools` with a 4xx,
  retry once without the rejected parameter and log the fallback (counts surface in
  `BUILD_REPORT.md`).
- STT: Deepgram streaming (`nova-2-phonecall`, mulaw, 8kHz)
- TTS: ElevenLabs streaming (`ulaw_8000`; verify the chosen voice supports that output
  format on `eleven_turbo_v2_5`); fallback Deepgram Aura (payload in Reference section)
- Telephony: Twilio Programmable Voice + Media Streams; outbound call creation via the
  `twilio` SDK (avoids hand-rolled signed REST), setting `status_callback` and the voice
  webhook URL. `X-Twilio-Signature` validation on inbound webhooks is intentionally out
  of scope for the prototype — document it as a production gap in the README.
- Tests: Vitest ^3 + `@vitest/coverage-v8`. Logging: pino. Config: dotenv + Zod-validated env.

## Repo layout

```
src/
  config/          schema.ts, loadCallScript.ts
  orchestrator/    Orchestrator.ts, promptBuilder.ts, stateMachine.ts
  llm/             LlmClient.ts, openaiClient.ts, mockClient.ts, parseToolCalls.ts
  tools/           definitions.ts, handlers.ts, index.ts
  escalation/      engine.ts, rules.ts
  extraction/      clinicalFields.ts, dischargeParser.ts, extractor.ts, summarize.ts
  transport/       AudioTransport.ts, TextTransport.ts, TwilioTransport.ts
  stt/             deepgramStream.ts
  tts/             elevenlabsStream.ts, deepgramAuraStream.ts
  server/          app.ts, routes.ts, mediaStream.ts, twiml.ts
  db/              schema.ts, client.ts, repositories/ (interfaces + Postgres + in-memory impls)
  eval/            runEvals.ts, metrics.ts, reporter.ts
public/            browser demo page (getUserMedia → WebSocket fallback transport)
evals/
  scenarios/*.yaml
  ground_truth/*.json
  discharge_docs/*.md
call_scripts/
  post_discharge_followup.yaml
migrations/
tests/             unit/ (no infra required) · integration/ (needs Postgres; auto-skip if down)
docker-compose.yml postgres:16-alpine + volume
drizzle.config.ts · vitest.config.ts · eslint.config.js · .prettierrc.json · .gitignore
README.md · BUILD_REPORT.md · DEMO.md · .env.example
```

`.gitignore` must cover `.env`, `node_modules/`, `dist/`, `evals/.cache/`.

npm scripts (package.json): `build` (tsc), `typecheck` (tsc --noEmit), `dev`
(tsx watch src/server/app.ts), `test` (vitest run), `test:coverage`
(vitest run --coverage), `db:up` (docker compose up -d), `db:generate` /
`db:migrate` (drizzle-kit), `db:seed` (loads synthetic patients + discharge docs),
`eval` (tsx src/eval/runEvals.ts). Pass eval flags after `--`:
`npm run eval -- --mock`.

## LLM client contract

`src/llm/LlmClient.ts`:

```ts
export interface LlmClient {
  chat(input: {
    system: string;
    messages: ChatMessage[];
    tools?: ToolDefinition[];
    temperature?: number;
    maxTokens?: number;
  }): Promise<{ text?: string; toolCalls: ToolCall[]; raw: unknown }>;

  extractStructured<T>(input: {
    schema: z.ZodType<T>;
    system: string;
    user: string;
  }): Promise<T>;
}
```

`src/llm/openaiClient.ts` constructs
`new OpenAI({ baseURL: env.LLM_BASE_URL, apiKey: env.LLM_API_KEY })` (defaults:
`http://localhost:8080/v1`; key required by omlx) and targets `env.LLM_MODEL`
(default `Qwen3.8-Flash-Next-oQ4e-mtp`).

`src/llm/mockClient.ts` returns scripted responses for **both** `chat` and
`extractStructured`, keyed per eval scenario. The canned `patient_turns` in a scenario
are the user side; the mock plays the agent. `extracted_fields` (e.g. `fever_f: 101.5`)
come from the mock's `extractStructured` path — not from the tool-call path — so
`--mock` exercises the same code the real client feeds the orchestrator.
## Tool-call tolerance (in openaiClient + parseToolCalls.ts)

Local models — including omlx/Qwen — occasionally emit malformed tool calls. Parse
tolerantly so the orchestrator never depends on the model doing this correctly.

- Timeouts: **12s for chat turns** (voice dead-air budget), **30s for
  `extractStructured`**. Retries: chat 1, extraction 2, with 200ms jitter.
- `temperature: 0.1`, `max_tokens: 256` for turns; `max_tokens: 768` for extraction.
- Strip `<think>...</think>` and any reasoning preamble from `text` before speaking
  (Qwen-family models emit these).
- Parse tool calls in this order, returning `[]` and logging on total failure:
  1. Native `tool_calls` array on the response.
  2. `<tool_call>{...}</tool_call>` blocks in `text`.
  3. Fenced ```json``` blocks containing an object with `name` and `arguments`.
  4. Bare JSON object with `name` and `arguments`.
- Coerce common quirks: `None`→`null`, `True`/`False`→`true`/`false`, unquoted numeric
  strings → numbers when the Zod schema expects numbers.
- `extractStructured`: send `response_format: { type: "json_object" }` and include the
  JSON schema + "respond with only valid JSON" in the system prompt. Validate with Zod;
  on failure, one repair retry with the validation error appended; then throw a typed
  `ExtractionError`.
- Record in a module-level counter how often each parser tier fires (and how often the
  `response_format`/`tools` parameter-fallback fires). Expose `toolCallStats()` **and
  `resetToolCallStats()`**. `runEvals.ts` resets counters before each run and documents
  that counters are module-global — the reported validity rate is per-run aggregate, not
  per-scenario under `--concurrency 2`.

## Architecture

The `stateMachine` owns the ordered steps from the YAML call script. The LLM generates
utterances and extracts fields but does not drive flow. At each turn, `Orchestrator`
calls `extractStructured` with a schema matching:

```ts
{ utterance: string, extracted_fields: ClinicalFields, step_complete: boolean }
```

Tool definitions are still passed and tool calls are still parsed/logged when present
(so the eval harness can report tool-call validity), but the orchestrator does not
depend on them. A post-turn extraction pass catches anything a malformed tool call
missed.

The escalation engine is independent of the LLM and always runs after extraction.

The `Orchestrator` depends only on `AudioTransport`, `LlmClient`, and repository
interfaces. That is what makes the eval harness possible without audio, network, or a
database.

- **Escalation actions (decision)** — the engine returns `Escalation[]`; the orchestrator
  acts on the highest urgency present:
  - `emergent` → speak a canned immediate-care line ("Please call 911 or your local
    emergency number now"), persist escalation rows, end the call with
    `outcome = escalated`, skipping remaining required steps. Ground truth in eval
    scenarios must reflect this short-circuit.
  - `urgent` → record escalation row + record a follow-up callback + continue the call.
  - `routine` → record escalation row + continue the call.
- **Step semantics (decision)** — every step has `max_attempts` (default 2) and
  `on_failure: retry | advance_with_flag | warm_transfer_to_staff`.
  `warm_transfer_to_staff` → speak a staff-handoff line, persist an escalation row
  (rule `identity_failed`), end with `outcome = escalated`.
- **Repositories** (`src/db/repositories/`) are interfaces with two implementations:
  Postgres (server) and in-memory (unit tests + eval harness), so `npm test` and
  `npm run eval -- --mock` never require Postgres.
- `promptBuilder` seeds every call from: the compiled script persona/steps, the
  `patients` row (first/last name, DOB for identity verification), the parsed discharge
  JSON, and `PRACTICE_NAME`. `{{var}}` placeholders interpolate from an env/config
  whitelist (`practice_name`); an unknown `{{var}}` fails script loading with a
  readable error rather than rendering literally.

## Canonical clinical fields & rule semantics

```ts
// src/extraction/clinicalFields.ts — one vocabulary for extraction, rules, and ground truth
export const ClinicalFields = z.object({
  identity_verified: z.boolean().optional(),
  pain_score: z.number().int().min(0).max(10).optional(),
  fever_f: z.number().min(90).max(115).optional(),
  shortness_of_breath: z.enum(['none', 'mild', 'moderate', 'severe']).optional(),
  chest_pain: z.boolean().optional(),
  wound_concern: z.boolean().optional(),
  medication_adherent: z.boolean().optional(),
  medication_issues: z.array(z.string()).default([]),
  followup_confirmed: z.boolean().optional(),
  next_steps: z.array(z.string()).default([]),
});
```

- Turn output is validated against `{ utterance, extracted_fields: ClinicalFields,
  step_complete }`; unknown fields are stripped and logged, never silently kept.
- Rule `op` vocabulary: `eq | neq | gt | gte | lt | lte | in | exists`.
- A rule can fire only if its field is **present and correctly typed**; a missing or
  mistyped field never fires (boundary tests must assert this).
- Conflicts (decision): **all** matching rules fire as separate `escalations` rows;
  urgency orders actions and notifications only. A rule dedupes per call by `rule_id` —
  the same rule + same value does not re-fire on later turns.
- `record_vital` handlers canonicalize names via one mapping table in
  `tools/handlers.ts`: `temperature_f → fever_f`; `heart_rate`, `spo2` pass through.
  Escalation rules and eval ground truth reference canonical names only.
- **Product decision**: medication non-adherence alone does **not** escalate in v1 — it
  surfaces in `summary.medication_issues`. Scenario `s07_fever_and_med_issue` expects
  only `fever_high`, intentionally. Revisit with a clinical advisor before any real use.
## Data model (Drizzle + Postgres)

```
organizations(id, name, created_at)
call_scripts(id, org_id, name, version, yaml_source, created_at)
patients(id, org_id, external_ref, first_name, last_name, dob, phone, created_at)
discharge_documents(id, patient_id, source_filename, raw_text, parsed_json, created_at)
calls(id, patient_id, call_script_id, twilio_call_sid /* UNIQUE — webhook idempotency */,
      status, started_at, ended_at, outcome, summary_text)
call_turns(id, call_id, idx, role, text, latency_ms, created_at)
extractions(id, call_id, field, value, confidence, created_at)
escalations(id, call_id, rule_id, reason, urgency, status, created_at)
```

uuid v4 ids, timestamptz, index `call_turns(call_id, idx)`.
`calls.status` = `ringing | in_progress | completed | failed | no_answer` — set by the
telephony lifecycle (Twilio status callbacks), never by the model.
`calls.outcome` = `completed | partial | refused | escalated` — set by agent logic.
`escalations.status` = `open | acknowledged | resolved` (default `open`).

## Call script format (`call_scripts/post_discharge_followup.yaml`)

```yaml
id: post_discharge_followup
version: 1
persona: |
  You are a warm, concise clinical follow-up assistant calling on behalf of
  {{practice_name}}. You are NOT a clinician and must never give medical advice,
  diagnoses, or dosing instructions. Keep turns under 2 sentences.
steps:
  - { id: greeting, instruction: "Introduce yourself and state the purpose of the call.", required: true }
  - { id: identity_verification, instruction: "Confirm you are speaking with the patient using DOB.",
      required: true, max_attempts: 2, on_failure: warm_transfer_to_staff }
  - { id: symptom_check, instruction: "Ask about pain, fever, wound condition, and shortness of breath.", required: true }
  - { id: medication_review, instruction: "Confirm the patient is taking prescribed medications.", required: true }
  - { id: wrap_up, instruction: "Summarize next steps and confirm the follow-up appointment.", required: true }
escalation_rules:
  - { id: fever_high, when: { field: fever_f, op: gte, value: 100.4 }, urgency: urgent, reason: "Fever >= 100.4F reported post-discharge" }
  - { id: chest_pain, when: { field: chest_pain, op: eq, value: true }, urgency: emergent, reason: "Chest pain reported" }
  - { id: severe_sob, when: { field: shortness_of_breath, op: eq, value: severe }, urgency: emergent, reason: "Severe shortness of breath reported" }
  - { id: identity_failed, when: { field: identity_verified, op: eq, value: false }, urgency: routine, reason: "Identity could not be verified; warm transfer to staff" }
```

`src/config/schema.ts` validates this with Zod: `op` ∈ the vocabulary above;
`when.field` must be a key of `ClinicalFields`; `on_failure` ∈
`retry | advance_with_flag | warm_transfer_to_staff`; `urgency` ∈
`routine | urgent | emergent`; `{{var}}` placeholders ∈ the interpolation whitelist.
`promptBuilder.ts` compiles it into a system prompt listing steps in order and returns
`requiredSteps: string[]`.

## Tools (LLM-callable, Zod-validated → JSON Schema via zod-to-json-schema)

- `record_symptom({ symptom: enum, severity: 1-10, onset: string, notes?: string })`
- `record_medication_adherence({ medication: string, taken: boolean, issues?: string })`
- `record_vital({ name: enum['temperature_f','heart_rate','spo2'], value: number })`
  — handler maps `temperature_f → fever_f` (canonical name; see Clinical fields section)
- `flag_red_flag({ symptom: string, reason: string, urgency: 'routine'|'urgent'|'emergent' })`
- `schedule_followup_callback({ iso_datetime: string, reason: string })`
- `end_call({ outcome: 'completed'|'refused'|'partial'|'escalated' })`
  — `no_answer` is deliberately **not** an option: that is a telephony lifecycle
  `status` from Twilio callbacks, never a model-initiated outcome.

Handlers validate with Zod and write via repositories. The escalation engine
re-evaluates all extracted fields after every turn and is the source of truth — the
model proposes, rules decide (actions per the Escalation actions decision). Document
this separation in the README.
## Build order

### Module A — Scaffold
Layout above; `docker-compose.yml` (postgres:16-alpine); Fastify `/healthz`; Drizzle +
first migration; Zod env validation (REQUIRED vs OPTIONAL tiers, see Env section);
config loader for the YAML call script; `db:seed` script; `.env.example`; Vitest +
`@vitest/coverage-v8`; ESLint (flat config) + Prettier; `.gitignore`.
Accept: `npm run db:up && npm ci && npm run build && npm test && npm run db:migrate &&
npm run dev` succeed; `/healthz` returns 200; a test loads and validates
`post_discharge_followup.yaml` and fails on a deliberately malformed copy. If
Docker/Postgres is unavailable, DB-dependent integration tests auto-skip, the unit
suite stays green, and `BUILD_REPORT.md` records it.

### Module B — State machine + orchestrator + mock
`stateMachine`, `promptBuilder`, `Orchestrator` against `LlmClient`. Tests use
`MockLlmClient` + in-memory repositories. Persist `calls`, `call_turns`, `extractions`.
Accept: a 6-turn text replay visits all required steps in order, persists turns, does
not import from `stt/`, `tts/`, or `server/`; plus a test where identity fails
`max_attempts` times → `warm_transfer_to_staff` fires and the call ends `escalated`.

### Module C — Extraction + summary
`dischargeParser` (text/markdown; **`pdf-parse` out of v1 scope** — fixtures are `.md`;
leave a documented TODO), `extractor` via `extractStructured` with the discharge schema:

```ts
{ patient_name, discharge_date, primary_diagnosis,
  medications: [{name, dose, frequency}],
  follow_up: { provider, within_days, reason },
  red_flags: string[] }
```

`summarize` returns the structured staff summary:

```ts
{ call_outcome, symptoms_reported[], medication_issues[], escalations[],
  next_steps[], one_line_summary }
```

Accept: 5 synthetic discharge docs parse into valid schema; one malformed doc returns a
typed error, not a crash.

### Module D — Escalation engine
Pure `evaluate(rules, fields): Escalation[]`. Priority emergent > urgent > routine.
Boundary tests: fever exactly 100.4; missing/mistyped fields never fire; multiple rules
firing on one turn; per-call dedupe of the same rule. ≥95% coverage on
`src/escalation/`.
Accept: `npm run test:coverage` shows ≥95% on `src/escalation/`.
### Module E — Eval harness
15 scenarios: 3 clean, 3 escalation (one emergent), 2 identity-failure, 2 confused,
2 refusals, 1 silence, 1 med-not-in-doc, 1 ambiguous severity. Ground truth references
canonical `ClinicalFields` names. Emergent scenarios' `required_steps_completed`
reflect the mid-call short-circuit (see Escalation actions). Ground-truth YAML per
scenario:

```yaml
id: s07_fever_and_med_issue
discharge_doc: discharge_docs/s07.md
patient_turns: ["yes this is him", "my temp was 101.5 last night",
                "I stopped the antibiotic, it made me sick",
                "no chest pain, breathing is fine", "okay thank you"]
expected:
  extractions: { fever_f: 101.5, chest_pain: false }
  escalations: [fever_high]
  required_steps_completed: [greeting, identity_verification, symptom_check,
                            medication_review, wrap_up]
```

`runEvals.ts` flags: `--mock`, `--real`, `--concurrency 2`, `--judge`. The judge uses
`JUDGE_BASE_URL`/`JUDGE_MODEL`, defaulting to `LLM_BASE_URL`/`LLM_MODEL` when unset.
Metrics: step adherence, extraction per-field P/R/F1 (aggregation: last non-null value
per field wins across turns), escalation P/R/F1, tool-call validity rate (from
`toolCallStats()`), latency (null in text mode), optional LLM-as-judge (second model
call scoring tone / instruction-following 1–5).

**Mock-vs-real semantics (decision):** `--mock` validates plumbing only — its metrics
are trivially green because the mock scripts its own extractions; mock numbers never
ship as results. Only `--real` metrics populate the headline table in
`eval-results.md` and the README.

`reporter.ts` writes `eval-results.md` with a metrics table + per-scenario pass/fail.
Cache each scenario result to `evals/.cache/` for resumability. Reset tool-call
counters at the start of each run.
Accept: `npm run eval -- --mock` green; `npm run eval -- --real` produces a report
when omlx is reachable (otherwise record endpoint state in `BUILD_REPORT.md`).

### Module F — Telephony pipeline
Routes:
- `POST /voice` — Twilio voice webhook (answer) → returns `<Connect><Stream>` TwiML;
  binds the incoming `callSid` to the open `calls` row.
- `POST /calls/status` — Twilio status callback; updates `calls.status`/`outcome`
  (including `no_answer`, `failed`, `completed`).
- `POST /calls/outbound` — creates the outbound call via the `twilio` SDK with
  `status_callback` + voice URL, inserts the `calls` row.
- `GET /calls` (recent list, for demos) · `GET /calls/:id` · `GET /calls/:id/summary`

`server/mediaStream.ts`, `TwilioTransport`, `deepgramStream`, `elevenlabsStream`
(+ Aura fallback), barge-in via Twilio `clear` (abort TTS on inbound speech),
per-turn latency into `call_turns.latency_ms`.

**Scripted barge-in test (no phone required):** a unit test drives the transport with
fake WS events (`start` → outbound `media` chunks queued → Deepgram speech-start
mid-TTS) and asserts a `{"event":"clear","streamSid":…}` frame is emitted to Twilio
and the in-flight TTS fetch is aborted.

If Twilio setup blocks for >45 minutes, ship the `public/` browser
`getUserMedia` → WebSocket transport instead and document it (works on localhost, no
tunnel). Do not burn the whole build on telephony. README quickstart includes
ngrok/cloudflared tunnel instructions and how to point Twilio at `PUBLIC_HOST`.
Accept (text/scripted, no keys required): a scripted call completes 5 steps, survives
one interruption (the fake-event test), persists all rows, and logs p50/p95 latency
(label them text-mode latency when not live). Live Twilio acceptance runs only with P2
credentials; otherwise `BUILD_REPORT.md` lists the exact remaining steps.

### Module G — Docs + report
README must contain: what it does, ASCII architecture diagram, 60-second demo video
link *(required at P2 only; at P0/P1 ship a placeholder explicitly marked
"pending voice credentials" alongside the scripted-call transcript + latency table)*,
quickstart (incl. `docker compose up`, omlx note, tunnel), env var table, YAML script
format with an example, eval results table, and a "Design decisions & tradeoffs"
section covering (a) config-driven scripts, (b) schema-validated tool calls,
(c) model-proposes / rules-decide escalation incl. the concrete action model,
(d) transport-agnostic orchestrator, (e) production-scale gaps (queues, idempotency,
HIPAA/BAA, webhook signature validation, audit logging, multi-tenancy).

`BUILD_REPORT.md` must state: model and endpoint used (omlx + `Qwen3.8-Flash-Next-oQ4e-mtp`
or the stub reason), parser tiers and their counts (from `toolCallStats()`, plus
`response_format`/`tools` param-fallback counts), module status, test counts, eval
metrics, known issues, exact re-run commands, and — if git is still uninitialized —
the intended per-module conventional-commit messages for the user to apply after
`git init`.

`DEMO.md` with a Loom recording script.
## Reference payloads

**Twilio TwiML for bidirectional media:**

```xml
<Response><Connect><Stream url="wss://YOUR_HOST/media" /></Connect></Response>
```

**Twilio → you (WebSocket JSON):** events `connected`, `start` (has `streamSid`,
`callSid`), `media` (`media.payload` = base64 μ-law 8kHz mono), `mark`, `stop`.

**You → Twilio:**

```json
{"event":"media","streamSid":"<sid>","media":{"payload":"<base64 ulaw>"}}
{"event":"clear","streamSid":"<sid>"}
```

**Deepgram streaming:** connect to
`wss://api.deepgram.com/v1/listen?model=nova-2-phonecall&encoding=mulaw&sample_rate=8000&channels=1&interim_results=true&endpointing=300&utterance_end_ms=1000`
with header `Authorization: Token <DEEPGRAM_API_KEY>`. Send raw binary audio frames.
Transcript at `channel.alternatives[0].transcript`; use `is_final` and `speech_final`.

**ElevenLabs streaming TTS:**
`POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream?output_format=ulaw_8000`
headers `xi-api-key: <key>`, `Content-Type: application/json`; body
`{"text":"...","model_id":"eleven_turbo_v2_5"}`. Response is a raw μ-law 8kHz stream —
chunk it (20–100ms), base64-encode, send as Twilio `media` events.

**Deepgram Aura TTS fallback (no ElevenLabs key):**
`POST https://api.deepgram.com/v1/speak?model=aura-2-thunder-en&encoding=mulaw&sample_rate=8000`
header `Authorization: Token <DEEPGRAM_API_KEY>`, body `{"text":"..."}`. Response is a
raw μ-law 8kHz byte stream — chunk, base64-encode, and send as Twilio `media` events
exactly like the ElevenLabs path.

## Env vars (`.env.example`)

```
# --- REQUIRED: missing any → fail fast at boot with a readable error ---
DATABASE_URL=postgres://postgres:postgres@localhost:5432/clinical_voice
LLM_BASE_URL=http://localhost:8080/v1            # omlx
LLM_MODEL=Qwen3.8-Flash-Next-oQ4e-mtp
LLM_API_KEY=                                     # omlx enforces a key — set it to the
                                                 # key omlx was started with

# --- OPTIONAL with defaults ---
JUDGE_BASE_URL=                                  # default = LLM_BASE_URL
JUDGE_MODEL=                                     # default = LLM_MODEL
PRACTICE_NAME=Sunrise Medical Group
LOG_LEVEL=info

# --- OPTIONAL_PARTIAL: missing → server boots in text-only mode (STT/TTS stubbed) ---
DEEPGRAM_API_KEY=
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM_NUMBER=
PUBLIC_HOST=                                     # tunnel hostname for Twilio voice/media webhooks
```

Zod validates at boot: missing REQUIRED → exit 1 listing what's missing. A **partial**
Twilio set (some keys present, not all) is an error naming the missing keys — silently
broken voice is worse than text-only. All-OPTIONAL-absent → warn and run text-only.

## Definition of done (tiered)

**P0 — unconditional, no credentials:**
1. `npm run build`, `npm test`, `npm run eval -- --mock` all green; escalation-engine
   coverage ≥ 95% (`npm run test:coverage`).
2. `.gitignore` in place; no PHI, no secrets committed; `.env` never committed;
   synthetic data only, with `SYNTHETIC DATA ONLY` headers in every fixture.
3. `BUILD_REPORT.md` complete: module status, test counts, known issues, exact re-run
   commands (+ intended commit messages if git is not yet initialized).

**P1 — omlx serving `Qwen3.8-Flash-Next-oQ4e-mtp` on localhost:8080 (verified live
2026-11-02):**
4. `npm run eval -- --real` produces a committed `eval-results.md` with a real-metrics
   table including tool-call validity rate, plus parser-tier counts in `BUILD_REPORT.md`.

**P2 — Twilio + Deepgram + ElevenLabs + public tunnel available:**
5. One recorded live call (Twilio, or browser-fallback transport) with transcript and
   p50/p95 latency numbers in the README, and the 60-second demo video link. Without
   voice credentials the README ships a clearly-marked placeholder instead — this does
   not block shipping P0/P1.

At every tier: `BUILD_REPORT.md` states model, endpoint, parser path used, module
status, test counts, eval metrics, known issues, and re-run commands.
