# clinical_voice_agent

Post-discharge follow-up voice agent: a local LLM runs a **config-driven call script**
over a phone/text channel, records structured clinical facts through **tool calls**, and a
**deterministic rules engine** (not the model) decides when a human must be paged.

Everything in this repo is **SYNTHETIC**: invented patients, invented discharge summaries,
invented clinical values. Nothing here is a medical device, and the design never accepts
real PHI — there is no path for it (no auth'd record store, no real patient table, no
HIPAA posture). It is a prototype for evaluating whether a local/open model can run a
clinical conversation safely enough to justify hardening.

> **Read [`BUILD_REPORT.md`](BUILD_REPORT.md) first** if you want to know exactly what is
> verified, what is stubbed, and what is broken today. `DEMO.md` is the recording script.

---

## Status at a glance

Verification as of 2026-11-03 (macOS, Node 22, omlx serving `Qwen3.8-Flash-Next-oQ4e-mtp`
at `localhost:8080/v1`):

| gate           | item                                           | status                                                                                 | evidence                                                                                                                                                                                                                                                                                                                                             |
| -------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| build          | `npm run typecheck`, `npm run build`           | ✅ pass                                                                                | clean, no errors                                                                                                                                                                                                                                                                                                                                     |
| lint           | `npm run lint`                                 | ✅ **0 errors / 0 warnings**                                                           | was 14 errors / 21 warnings; see BUILD_REPORT "Lint cleanup"                                                                                                                                                                                                                                                                         |
| tests          | `npm test`                                     | ⚠️ 60 tests / 4 files pass                                                             | plan calls for ~14 module suites                                                                                                                                                                                                                                                                                                                     |
| coverage       | `src/escalation/**` ≥ 95 %                     | ❌ **≈ 8.8 % lines**                                                                   | engine has zero direct tests                                                                                                                                                                                                                                                                                                                         |
| eval (mock)    | `npm run eval -- --mock`                       | ✅ **15 / 15 pass**                                                                    | plumbing only — see caveat                                                                                                                                                                                                                                                                                                                           |
| speech quality | agent says something useful on tool-call turns | ❌ **46 / 66 mock-call turns print the canned "I'm sorry, could you say that again?"** | BUILD_REPORT issue #3; the harness asserts facts, never utterances                                                                                                                                                                                                                                                                                   |
| eval (real)    | `npm run eval -- --real --force`               | ❌ not yet run                                                                         | omlx is live (HTTP 200 on `/v1/models`)                                                                                                                                                                                                                                                                                                              |
| database       | `npm run db:migrate`                           | ❌ `Can't find meta/_journal.json file`                                                | `migrations/` was never generated — `npm run db:generate` has never been run, so the repo ships no SQL                                                                                                                                                                                                                                               |
| database       | `npm run db:seed`                              | ❌ `password authentication failed`                                                    | `.env.example` (and the code default in `src/config/env.ts`) ship `***` as the password, but compose creates the role with `postgres` → any `cp .env.example .env` gets `28P01`; host auth as `postgres` verified OK on 03 Nov                                                                                                                       |
| database       | tables exist                                   | ❌ 0 tables in `clinical_voice`                                                        | container healthy on 5432, schema never applied                                                                                                                                                                                                                                                                                                      |
| server         | boot + `/healthz`                              | ❌ **process dies at boot today**                                                      | `deps.ready` (`src/server/deps.ts:76`) is never awaited by `startServer`; its only `.catch()` is attached lazily inside the `/healthz` handler (`src/server/routes.ts:55`), so if nothing hits `/healthz` first the bootstrap `28P01` is an unhandled rejection → exit. `/healthz` itself is implemented and answers correctly once the DSN is fixed |
| docs           | README / BUILD_REPORT / DEMO                   | ✅ these three files                                                                   | written at current-state honesty                                                                                                                                                                                                                                                                                                                     |
| P2 voice       | live Twilio ↔ Deepgram ↔ ElevenLabs            | ❌ deferred (documented placeholder)                                                   | code paths exist + unit-tested, no live call yet                                                                                                                                                                                                                                                                                                     |

**What works today, unmodified:** the CLI conversational demo against local omlx or the
scripted mock (`npm run demo:call [--mock]` — it injects in-memory repositories, so no
database is needed), and the mock eval harness (`npm run eval -- --mock`, 15/15).
**What does not work today:** anything that touches Postgres. `db:migrate` fails because the
repo ships no SQL (`migrations/` was never generated), and `db:seed` fails `28P01` because
`.env.example` — and the built-in defaults in `src/config/env.ts` and `drizzle.config.ts` —
use the placeholder password `***`, while `docker-compose.yml` provisions the role with
`postgres`. So the documented path `cp .env.example .env` cannot authenticate. The HTTP server
then dies at boot on the resulting unhandled rejection. Both fixes are minutes of work: point
`DATABASE_URL` at the compose password, then `npm run db:generate && npm run db:migrate &&
npm run db:seed`. After that the browser demo at `http://localhost:3000/` is expected to work;
it is **not verified yet**. Voice (P2) has never carried a real call.

---

## Architecture

```
                        ┌──────────────────────────────────────────────┐
  YAML call script ───► │  config (zod-validated at load)              │
  (steps, rules,        │  steps + max_attempts + on_failure           │
   persona, rules)      │  escalation_rules  {{var}} whitelist         │
                        └───────────────────┬──────────────────────────┘
                                            │ LoadedCallScript
  REST /calls/text ─┐                     ▼
  WS  /ws/call ─────┼──► ┌───────────────────────────────┐      ┌──────────────────┐
  Twilio Voice webhook│    │  Orchestrator (transport-      │      │ LlmClient        │
  WS /media (audio) ─┘    │  agnostic)                     │─────►│  OpenAiCompat    │──► omlx /v1
                          │  • one chat() per turn           │      │  (response_format│    (Qwen3.8-Flash)
                          │  • bounded inner tool loop       │      │   + tools, with │
                          │  • step cursor ownership         │      │   param degra-  │
                          │  • termination policy            │      │   dation retry) │
                          └───────┬───────────────┬─────────┘      │  Mock (scripted)│
                                  │               │                  └──────────────────┘
                     CallStateMachine          tools/handlers
                     (retry / flag /         (zod re-validate, alias
                      warm transfer)         canonicalisation, ranges)
                                  │               │
                                  ▼               ▼
              ┌────────────────────────────────────────────────┐
              │ escalation/engine.ts  ← DETERMINISTIC          │
              │ evaluateRules(fields) per turn, per-call dedupe│
              │ urgency rank → action map, safety lines         │
              └───────────────┬────────────────────────────────┘
                              │ Notifier (escalations row + optional webhook)
                              ▼
              ┌────────────────────────────────────────────────┐
              │ repositories (Postgres via drizzle | in-memory) │
              │ calls · call_turns · extractions · escalations  │
              │ followups · patients · discharge_documents …    │
              └───────────────┬────────────────────────────────┘
                              ▼
                    summarize → staff summary (structured + text)

  Audio path (P2, unverified live): Twilio Media Streams ⇄ transport/TwilioTransport
  (μ-law 8 kHz, barge-in via `clear` + TTS abort) → Deepgram STT / ElevenLabs TTS.
  Text path (verified): TextTransport ← CLI, browser page, eval harness.
```

Three boundaries are deliberate:

- **The orchestrator never imports `stt/`, `tts/`, or `server/`.** Voice is injected, so
  the whole agent runs (and is tested) with no audio stack at all.
- **The model proposes; rules decide.** `flag_red_flag` writes an audit row and nothing
  else. Only `src/escalation/engine.ts` can create an escalation.
- **`calls.status` is telephony lifecycle; `calls.outcome` is agent logic.** A dropped
  call (`no_answer`) never silently becomes a model "decision".

---

## Design decisions and tradeoffs

| decision                                    | why                                                                                                                                                                                                                                                | cost                                                                                                                             |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Script = configuration, cursor = code**   | New call types (pre-op instructions, chronic-care check-in) should be YAML, not a new orchestrator. Steps carry `max_attempts` and `on_failure`.                                                                                                   | A script cannot express branching/loops; anything conditional must become a new step or a rule.                                  |
| **Model proposes, rules decide**            | Escalation must not depend on sampling temperature. `flag_red_flag` is a proposal; `escalation/engine.ts` owns the decision, evaluated **every turn** from canonical field state.                                                                  | The model sometimes wants to escalate and is overruled by rules; that's intended, and the proposal is still persisted for audit. |
| **Canonical clinical vocabulary**           | 10 field names shared by extraction, tools, rules, fixtures and ground truth. Aliases (`temperature_f`) are canonicalised at exactly one seam (`tools/handlers.ts`).                                                                               | Adding a field touches five places; the schema test is the guard.                                                                |
| **Type-checked rules**                      | `op`/value compatibility is checked against the field kind at _load_ time — `gte` on a boolean, or an out-of-range enum value, is rejected when the YAML loads instead of silently doing nothing mid-call.                                         | Rule authors must understand the field-kind table to get past load.                                                              |
| **`{{var}}` whitelist**                     | Only `practice_name` interpolates. Unknown placeholders fail at load instead of reaching a patient's phone as literal `{{practice_name}}`.                                                                                                         | Adding a variable means editing the whitelist (`config/interpolate.ts`) — deliberate friction.                                   |
| **`status` vs `outcome`**                   | `calls.status` (telephony: ringing/in_progress/completed/failed/no_answer) is kept apart from `calls.outcome` (agent logic: completed/partial/refused/escalated). A dropped call is `status=no_answer, outcome=partial`, never a model "decision". | Two columns to reason about in queries and dashboards.                                                                           |
| **Per-call rule dedupe by `rule_id`**       | A fever must not re-page every turn; one escalation row per call per rule.                                                                                                                                                                         | A worsening value under the same rule (100.4 → 103.1) does not re-notify — see BUILD_REPORT issue list.                          |
| **Escalation short-circuits the script**    | An `emergent` match ends the call immediately with the 911 line; the model's drafted utterance is discarded.                                                                                                                                       | You lose the remaining steps — correct trade, and the summary records what was missing.                                          |
| **Transport-agnostic orchestrator**         | `Orchestrator` receives `LlmClient` + `Repositories` + `Notifier`; audio is a separate concern. Enables text-mode evals/demos on a laptop with no credentials.                                                                                     | Voice-specific bugs (barge-in timing, μ-law framing) can't be caught by orchestrator tests.                                      |
| **In-process live call state**              | Resume-in-flight across restart is out of P0 scope; Postgres holds the durable audit trail and `GET /calls/:id/summary` rebuilds from rows.                                                                                                        | A crash mid-call loses the step cursor (the transcript survives).                                                                |
| **`response_format` / `tools` degradation** | Local servers reject OpenAI parameters in surprising ways. On rejection the client disables that parameter for the process lifetime, counts it, and retries; the tolerant parser absorbs the fallout.                                              | A capability downgrade that could pass unnoticed — hence the counters in eval output and `/healthz`.                             |
| **Mock eval is plumbing, not quality**      | The scripted mock is handed the ground truth, so 15/15 mock says nothing about the model. Labelled everywhere it appears.                                                                                                                          | Two eval modes to keep honest about.                                                                                             |

---

## Quickstart

Node **≥ 22**. Everything below runs without any cloud credential.

```bash
npm install
cp .env.example .env            # then set LLM_API_KEY to your omlx key AND replace the
                                # `***` password in DATABASE_URL with `postgres` (the compose
                                # default) — as shipped, the placeholder cannot authenticate

# 1. database  (NB: migrations are missing, so this is NOT yet a working path)
npm run db:up
npm run db:generate           # creates migrations/ + meta/_journal.json — never committed
npm run db:migrate            # applies them; then `npm run db:seed`

# 2. model: any OpenAI-compatible endpoint. Locally via omlx:
#      LLM_BASE_URL=http://localhost:8080/v1
#      LLM_MODEL=Qwen3.8-Flash-Next-oQ4e-mtp
#      LLM_API_KEY=<auth.api_key from ~/.omlx/settings.json>

# 3. verify the toolchain
npm run typecheck && npm run build && npm test

# 4. text-mode demo against the local model (no Twilio, no audio)
npm run demo:call

# 5. or the browser demo
npm run dev          # then open http://localhost:3000/

# 6. evals
npm run eval -- --mock          # plumbing check, ~1 s, no GPU needed
npm run eval -- --real --force  # real model, writes eval-results.md
```

What each entry point needs (the server always uses the Postgres repositories, so the
browser demo needs a _migrated_ database; the CLI demo injects in-memory repositories):

| entry point                              | Postgres                                                                                                                             | model                         | cloud keys |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- | ---------- |
| `npm run eval -- --mock`                 | no                                                                                                                                   | scripted mock                 | no         |
| `npm run demo:call [--mock]`             | no (in-memory repos)                                                                                                                 | optional with `--mock`        | no         |
| `npm run dev` + `http://localhost:3000/` | **yes**                                                                                                                              | optional with `MOCK_LLM=true` | no         |
| `/healthz` alone                         | unreliable — it only answers if hit before the bootstrap rejection lands; otherwise the process exits (`deps.ts:76`, `routes.ts:55`) | no                            | no         |

`/healthz` check (the shape the endpoint returns once Postgres accepts connections — today
the process exits before it can serve, see BUILD_REPORT issue #2):

```bash
MOCK_LLM=true npx tsx src/server/app.ts &      # boots, warns "TEXT-ONLY mode"
curl -s localhost:3000/healthz
# {"ok":true,"llm":"mock","model":"Qwen3.8-Flash-Next-oQ4e-mtp",
#  "repositories":"postgres","textOnly":true,
#  "script":"post_discharge_followup@1",
#  "requiredSteps":["greeting","identity_verification","symptom_check",
#                  "medication_review","wrap_up"]}
```

Today the same command produces:

```
{"level":40,...,"msg":"no voice-provider credentials found — running in TEXT-ONLY mode (REST + WebSocket)"}
{"level":30,...,"msg":"clinical_voice_agent listening"}
error: password authentication failed for user "postgres"   # 28P01, unhandled → exit
```

If Postgres refuses connections (`28P01 password authentication failed for user "postgres"`),
suspect the DSN before suspecting the container. Verified on 03 Nov: the running volume
accepts the compose default (`postgres`), and `information_schema.tables` for `public` came
back empty — i.e. the server is fine, the _client_ credential is not. `.env.example`,
`src/config/env.ts` and `drizzle.config.ts` all ship the literal placeholder `***`, so any
checkout that followed the quickstart inherits a broken DSN. `psql` from inside the container
is no evidence either way — `pg_hba.conf` grants `local` trust. Full diagnosis and the exact
probe commands are in
[`BUILD_REPORT.md` → Known issues](BUILD_REPORT.md#known-issues).

---

## Environment variables

Loading is tiered and the failure mode is deliberate: missing _required_ keys aborts at
boot listing exactly what is missing, and a _half-configured_ provider group aborts too,
because silently broken voice is worse than honest text-only mode.

### Required (missing any → `exit 1` with a named list)

| variable       | dev fallback                                            | meaning                                                                                                                                                                                                             |
| -------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL` | `postgres://postgres:***@localhost:5432/clinical_voice` | Postgres DSN for the audit trail. The shipped default is literal: `***` is a placeholder, not the container's password (compose provisions `postgres`), so copy-and-run fails `28P01` until it is edited — issue 2. |
| `LLM_BASE_URL` | `http://localhost:8080/v1`                              | OpenAI-compatible endpoint.                                                                                                                                                                                         |
| `LLM_MODEL`    | `Qwen3.8-Flash-Next-oQ4e-mtp`                           | Model id served by that endpoint.                                                                                                                                                                                   |
| `LLM_API_KEY`  | _none on purpose_                                       | Key for that endpoint (omlx: `auth.api_key` in `~/.omlx/settings.json`).                                                                                                                                            |

### Optional with defaults

| variable                         | default                 | meaning                                                        |
| -------------------------------- | ----------------------- | -------------------------------------------------------------- |
| `JUDGE_BASE_URL` / `JUDGE_MODEL` | inherit `LLM_*`         | Endpoint/model used by `npm run eval -- --judge`.              |
| `PRACTICE_NAME`                  | `Sunrise Medical Group` | Fills `{{practice_name}}` in scripts.                          |
| `LOG_LEVEL`                      | `info`                  | pino level.                                                    |
| `PORT` / `HOST`                  | `3000` / `127.0.0.1`    | HTTP bind.                                                     |
| `MOCK_LLM`                       | `false`                 | `true` swaps in the scripted mock client (no GPU, no keys).    |
| `ESCALATION_WEBHOOK_URL`         | unset                   | Best-effort POST on each escalation; the DB row is the record. |
| `ESCALATION_STAFF_NUMBER`        | unset                   | Target for warm-transfer `<Dial>`.                             |

### Optional _partial_ groups (all-or-nothing)

| group     | keys                                                                           | all absent            | some present                       |
| --------- | ------------------------------------------------------------------------------ | --------------------- | ---------------------------------- |
| Telephony | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `PUBLIC_HOST` | text-only mode (warn) | `EnvError` naming the missing keys |
| Voice-out | `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`                                    | text-only mode (warn) | `EnvError` naming the missing keys |
| Voice-in  | `DEEPGRAM_API_KEY`                                                             | text-only mode (warn) | n/a (single key)                   |

`env.textOnly === true` when all of the above are absent — the configuration this repo has
actually been verified in.

---

## The call script

`call_scripts/post_discharge_followup.yaml` is the shipped script. A script is validated at
load (`config/schema.ts`) and any failure raises `CallScriptError` listing every problem:

```yaml
id: post_discharge_followup
version: 1
persona: |
  You are a warm, concise clinical follow-up assistant calling on behalf of
  {{practice_name}}. You are NOT a clinician and must never give medical advice,
  diagnoses, or dosing instructions. Keep turns under 2 sentences.
steps:
  - {
      id: greeting,
      instruction: 'Introduce yourself and state the purpose of the call.',
      required: true,
    }
  - {
      id: identity_verification,
      instruction: 'Confirm you are speaking with the patient using DOB.',
      required: true,
      max_attempts: 2,
      on_failure: warm_transfer_to_staff,
    }
  - {
      id: symptom_check,
      instruction: 'Ask about pain, fever, wound condition, and shortness of breath.',
      required: true,
    }
  - {
      id: medication_review,
      instruction: 'Confirm the patient is taking prescribed medications.',
      required: true,
    }
  - {
      id: wrap_up,
      instruction: 'Summarize next steps and confirm the follow-up appointment.',
      required: true,
    }
escalation_rules:
  - {
      id: fever_high,
      when: { field: fever_f, op: gte, value: 100.4 },
      urgency: urgent,
      reason: 'Fever >= 100.4F reported post-discharge',
    }
  - {
      id: chest_pain,
      when: { field: chest_pain, op: eq, value: true },
      urgency: emergent,
      reason: 'Chest pain reported',
    }
  - {
      id: severe_sob,
      when: { field: shortness_of_breath, op: eq, value: severe },
      urgency: emergent,
      reason: 'Severe shortness of breath reported',
    }
  - {
      id: identity_failed,
      when: { field: identity_verified, op: eq, value: false },
      urgency: routine,
      reason: 'Identity could not be verified; warm transfer to staff',
    }
```

**Step fields** — `id` (snake_case, unique), `instruction` (what the model is asked to do
this turn), `required` (default `true`), `max_attempts` (1–6, default 2), `on_failure`
(`retry` | `advance_with_flag` | `warm_transfer_to_staff`, default `retry`).

**Rule `op`s** — `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `exists`, checked against the
field's kind (`boolean` allows eq/neq/exists; `number` allows the comparators; `enum`
allows eq/neq/in against its value list; `string_array` allows exists/in).

**Urgency → action** (deterministic, `escalation/engine.ts`):

| urgency    | action              | effect on the call                                                                                                                                                               |
| ---------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `emergent` | `terminate_now`     | Model's drafted reply is replaced by _"That sounds urgent. Please hang up and call 911 now. I am alerting your care team."_, remaining steps are skipped, `outcome = escalated`. |
| `urgent`   | `advise_and_finish` | The 911-if-worse advisory is appended once, remaining steps continue, `outcome = escalated`.                                                                                     |
| `routine`  | `record_only`       | Audit row only; the call may still end `completed`.                                                                                                                              |

Missing or mistyped fields **never** match — `unknown` is not `false`.

---

## Canonical clinical fields

One vocabulary (`extraction/clinicalFields.ts`), shared by tools, rules, fixtures and ground
truth. Unknown keys in a model payload are dropped and logged as `stripped`, never stored.

| field                 | kind     | range / values                  | written by                                                                                 |
| --------------------- | -------- | ------------------------------- | ------------------------------------------------------------------------------------------ |
| `identity_verified`   | boolean  | true / false                    | `record_identity_verification`                                                             |
| `pain_score`          | number   | 0–10                            | `record_symptom(symptom: pain)`                                                            |
| `fever_f`             | number   | 90–115                          | `record_vital(name: temperature_f)`                                                        |
| `shortness_of_breath` | enum     | none / mild / moderate / severe | `record_symptom(shortness_of_breath)` via severity band (<4 mild, 4–7 moderate, ≥8 severe) |
| `chest_pain`          | boolean  |                                 | `record_symptom(chest_pain)`                                                               |
| `wound_concern`       | boolean  |                                 | `record_symptom(wound)`                                                                    |
| `medication_adherent` | boolean  |                                 | `record_medication_adherence`                                                              |
| `medication_issues`   | string[] | union across turns              | `record_medication_adherence(issues)`                                                      |
| `followup_confirmed`  | boolean  |                                 | `schedule_followup_callback`                                                               |
| `next_steps`          | string[] | union across turns              | callbacks, denial notes, model-provided next steps                                         |

Merging rule: scalars — latest explicit value wins; arrays — deduplicated union.

---

## Tools the model may call

Seven tools (`tools/definitions.ts`), each re-validated server-side (`tools/handlers.ts`)
after a coercion layer fixes common local-model quirks (Python literals `True`/`None`,
stringified argument objects, name drift like `RecordSymptom`).

| tool                           | arguments (abridged)                                                                                                                             | effect                                                                                                                                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `record_symptom`               | `symptom` ∈ pain/fever/shortness_of_breath/chest_pain/wound/nausea/dizziness/other, `severity` 1–10, `onset`, `presence` (default true), `notes` | Writes the canonical field for that symptom — including explicit **denials** (`presence:false` → `chest_pain:false`, `pain_score:0`, `shortness_of_breath:'none'`), which is what rules need. Denials of symptoms with no canonical field are still audited. |
| `record_vital`                 | `name` ∈ temperature_f/heart_rate/spo2, `value`                                                                                                  | `temperature_f` → canonical `fever_f` with a plausibility guard (90–115 °F). `heart_rate`/`spo2` are audited only: no canonical field exists, so they cannot drive a rule.                                                                                   |
| `record_medication_adherence`  | `medication`, `taken`, `issues`                                                                                                                  | Sets `medication_adherent`; appends `medication_issues`.                                                                                                                                                                                                     |
| `record_identity_verification` | `verified`, `method` ∈ dob/name_and_dob/other, `note`                                                                                            | The only write path for `identity_verified`. _This is the seventh tool — see the deviation note below._                                                                                                                                                      |
| `flag_red_flag`                | `symptom`, `reason`, `urgency`                                                                                                                   | **Proposal only.** Persists `red_flag_proposal:<symptom>` for audit and returns _"Recorded as a proposal. Clinical escalation rules determine whether a clinician is paged."_ It cannot create an escalation.                                                |
| `schedule_followup_callback`   | `iso_datetime`, `reason`                                                                                                                         | Validates ISO-8601 shape, writes a `followups` row, sets `followup_confirmed`, contributes a `next_steps` line.                                                                                                                                              |
| `end_call`                     | `outcome` ∈ completed/refused/partial/escalated                                                                                                  | Ends the turn loop; the orchestrator still recomputes the outcome from rules + step state (so a model that claims `completed` on an escalated call is overruled). `no_answer` is deliberately absent — that is telephony, not a decision.                    |

> **Deviation from the plan's six-tool list.** `identity_verified` is a canonical field with
> no write path among the original six, and inventing a free-form field would break the
> canonical-vocabulary rule, so `record_identity_verification` was added. Everything else
> matches the plan.

## HTTP / WebSocket surface

| method + path                                              | purpose                                                                                                                                      | without Postgres / Twilio                                 |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `GET /healthz`                                             | mode, model, repo kind, script id, required steps                                                                                            | works (but see the boot crash)                            |
| `POST /ingest/discharge`                                   | `{patient} or {patientId}, plus documentMarkdown and sourceFilename` → markdown discharge parse (+ LLM fallback) → `discharge_documents` row | needs Postgres                                            |
| `GET /patients`                                            | list seeded synthetic patients for the demo UI                                                                                               | needs Postgres                                            |
| `POST /calls/text`                                         | `{patientId}` → start a text-mode call, returns the greeting turn                                                                            | needs Postgres                                            |
| `POST /calls/:id/turn`                                     | `{utterance}` → one turn                                                                                                                     | needs Postgres                                            |
| `POST /calls/:id/end`                                      | `{outcome?}` → end + summary (default `refused`)                                                                                             | needs Postgres                                            |
| `GET /calls` · `GET /calls/:id` · `GET /calls/:id/summary` | audit reads                                                                                                                                  | needs Postgres                                            |
| `GET /escalations/open`                                    | open escalations for the staff queue                                                                                                         | needs Postgres                                            |
| `POST /calls/outbound`                                     | place a real call via Twilio                                                                                                                 | `503` naming the four missing keys                        |
| `POST /voice`                                              | Twilio voice webhook → `<Connect><Stream url="wss://HOST/media?callSid=…">`                                                                  | `503` + `<Say>` fallback                                  |
| `POST /calls/status`                                       | Twilio status callback; idempotent per `CallSid`+status; writes `status` only, plus `outcome=partial` for dropped calls                      | needs Postgres                                            |
| `GET /calls/:id/warm-transfer-twiml`                       | `<Say>` + `<Dial timeout="20">` to the staff line                                                                                            | `503` if no staff number                                  |
| `WS /ws/call?callId=…`                                     | browser text transport (`{type:"text",text}` → `{type:"agent_text",…}`)                                                                      | needs Postgres                                            |
| `WS /media`                                                | Twilio Media Streams (μ-law 8 kHz, barge-in)                                                                                                 | closes with an explicit reason if STT/TTS keys are absent |
| `GET /`                                                    | static `public/index.html` demo page                                                                                                         | works                                                     |

**`X-Twilio-Signature` validation is not implemented** — acceptable for a prototype on a
tunnel, never acceptable in production.

## Turn lifecycle

One `POST /calls/:id/turn` (or one final STT utterance) does, in order:

1. append the patient utterance to `call_turns`;
2. build the system prompt (persona + patient context + step table with `DONE/NOW/later` +
   known canonical fields + red-flag list + failure hint) and the last-12-message history;
3. run up to **3** inner LLM iterations, executing any tool calls and feeding back
   `role:"tool"` results;
4. persist extraction deltas;
5. evaluate every escalation rule against the merged field state, notify rules not already
   fired **this call**, and possibly replace the reply with a safety line;
6. advance or fail the active step (`step_complete` signal _or_ deterministic evidence in the
   canonical fields), applying `on_failure` when the attempt budget is spent;
7. apply the termination policy — emergent → `escalated`; pending warm transfer → say the
   transfer line → `escalated`; model `end_call(refused)` → `refused`; model `end_call(...)`
   → rules win if they force escalation; all steps terminal or `turnCount ≥ maxTurns (12)` →
   `completed` / `partial`;
8. persist the agent utterance with per-turn latency, and on termination write
   `outcome`, `ended_at` and the human-readable summary.

---

## Evals

```bash
npm run eval -- --mock                  # scripted agent, in-memory repos, reuses cache
npm run eval -- --real --force       # omlx drives every turn (P1); bypasses the cache
npm run eval -- --real --judge       # adds an LLM-judge verdict per call (safety 1–5)
npm run eval -- --real --concurrency 3
npm run scenarios:gen              # regenerate scenario YAML + discharge docs (synthetic)
```

| flag                | meaning                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `--mock` / `--real` | mode; default `mock`. `--real` requires the four required env vars.                                                |
| `--force`           | ignore `evals/.cache/` and re-run every scenario.                                                                  |
| `--judge`           | only meaningful with `--real`: per-call LLM rubric (safety, groundedness, brevity…).                               |
| `--concurrency n`   | parallel workers. Parser counters are module-global, so with n > 1 they are a per-run aggregate, not per scenario. |

**Pass criteria per scenario:** outcome equals expected · every expected canonical field
correct · escalation set exact (no missing, no spurious) · no required step missing.

**Metric definitions** (`eval/metrics.ts`): extraction is per-field P/R/F1 — a field counts
as a false positive when the agent recorded something absent from ground truth (`next_steps`
is excluded as a derived field); escalations and required steps are set-matched; numeric
compare allows ±0.05; array expectations pass when every expected item is present; latency is
per-turn `call_turns.latency_ms` p50/p95. **In text mode latency excludes STT/TTS** — the
report labels it `text-mode (audio pipeline not measured)`.

### Current results

`npm run eval -- --mock` → **15 / 15 pass**, extraction F1 100 %, escalation F1 100 %, step
adherence 100 %, p50 0 ms / p95 1 ms, judge disabled. Full table:
[`eval-results.md`](eval-results.md).

Those numbers say the orchestration, rule engine, dedupe, persistence and scoring plumbing
behave as designed. They say **nothing** about the model: the scripted mock's tool calls are
generated _from_ the ground truth. `npm run eval -- --real --force` has **not been run yet**
and is the gate for any headline quality claim.

One thing the mock run _does_ expose, if you read the transcripts instead of the aggregate:
**46 of the 66 agent turns across those 15 calls are the canned
`"I'm sorry, could you say that again?"`** while the scenarios still score 100 %. That is a
real defect (any response carrying both text and tool calls currently speaks nothing —
[BUILD_REPORT issue #3](BUILD_REPORT.md#known-issues)), and it is invisible to the pass
criteria because the harness asserts facts, escalations, steps and outcomes but never
utterances.

## Tests

```bash
npm test               # vitest run
npm run test:coverage  # v8 coverage; thresholds configured in vitest.config.ts
npm run typecheck      # app + test tsconfigs
```

| suite                               | tests                     | covers                                                                                                       |
| ----------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `tests/unit/configScript.test.ts`   | 11                        | YAML schema, step/rule validation, `op`↔field-kind compatibility, placeholder whitelist                      |
| `tests/unit/parseToolCalls.test.ts` | 28                        | the four parse tiers, malformed tool-call corpus, reasoning-preamble stripping                               |
| `tests/unit/mulaw.test.ts`          | 13                        | μ-law encode/decode round-trip, framing, 8 kHz pacing math                                                   |
| `tests/unit/coerce.test.ts`         | 8                         | Python-literal / stringified-argument coercion                                                               |
| `tests/helpers/testSetup.ts`        | —                         | reusable app/orchestrator/tool-call fixtures (**currently unused — the suites it exists for are unwritten**) |
| **total**                           | **60 passing in 4 files** |                                                                                                              |

Missing (plan-required, all unwritten): `escalationEngine`, `stateMachine`, `orchestrator`,
`extractor`, `toolHandlers`, `routes`, `bargeIn`, `postgres` (auto-skip when no DB), plus
the adversarial non-hallucination suite. `src/escalation/**` sits at **≈ 8.8 %** line
coverage against a **95 %** gate — the most important gap, because that module _is_ the
safety property.

## Repository layout

```
call_scripts/            YAML call scripts (validated at load)
evals/
  scenarios/             15 scenario YAMLs        discharge_docs/  6 synthetic summaries
  ground_truth/          index.json — canonical expectations
  .cache/                per-scenario run cache (gitignored)
public/                  browser text-mode demo page (index.html + app.js)
src/
  common/       logger                            config/     env tiers, script schema, interpolation
  db/           drizzle schema, memory + postgres repos, bootstrap, migrate runner
  escalation/   deterministic engine, notifier (DB row + best-effort webhook)
  extraction/   canonical clinical fields, discharge parser, extractor, summarizer
  llm/          OpenAI-compatible client, mock client, tolerant tool-call parser, coercion, stats
  orchestrator/ state machine, prompt builder, Orchestrator
  scripts/      seed, synthetic fixtures, CLI demo
  server/       Fastify app, routes, TwiML, media + text WebSockets, deps composition
  stt/          Deepgram streaming (+ mock)       tts/        ElevenLabs streaming (+ Aura fallback)
  tools/        definitions, coercion, handlers   transport/  AudioTransport interface, Twilio, Text
  eval/         harness, metrics, judge, scenarios, reporter
tests/          unit/ (4 suites today) + helpers/testSetup.ts
```

## Production gaps (explicit)

Not a TODO laundry list — these are the reasons this is a prototype and not a deployable
system:

- **No auth anywhere.** Every HTTP endpoint is open; `X-Twilio-Signature` is not verified on
  inbound webhooks.
- **No PHI posture.** No encryption-at-rest story, no audit retention policy, no BAA'd
  vendors, no de-identification pipeline. By design this repo handles invented patients only;
  keep it that way until the compliance work exists.
- **No restart-safe calls.** Live step state is in-process; a crash mid-call loses the cursor
  (turns and escalations survive in Postgres, and `GET /calls/:id/summary` rebuilds from
  rows).
- **Escalation = DB row + best-effort webhook.** No paging integration, no ack loop, no
  on-call rota, no escalation-of-escalation, and dedupe is per rule id — a fever worsening
  from 100.4 °F to 103.1 °F does not re-notify.
- **PDF/OCR ingestion out of v1 scope.** `parseDischargeFile` raises a typed error for `.pdf`;
  the LLM path handles markdown/text only.
- **Latency is text-mode.** Real turn latency (STT final → agent first byte → TTS first byte)
  needs the P2 audio path measured end to end.
- **Boot is fail-hard on the database.** No degraded mode, no `memory` repository switch for
  the server, and DB bootstrap failures surface as unhandled rejections instead of a clean 503.
- **No CI, no rate limiting, no multi-tenant isolation, no secret management.**
- **No model governance.** The served checkpoint is whatever the endpoint happens to load; no
  pinning, no scheduled drift re-eval, no regression gate between prompt changes.
- **One practice, one script, one language, US-centric 911 wording.**

---

## Disposition

Internal prototype, synthetic data only. Do not point this at real patients, real numbers or
real records without the compliance, security and clinical-review work listed above. See
[`BUILD_REPORT.md`](BUILD_REPORT.md) for the honest verification log and
[`DEMO.md`](DEMO.md) for the recording script.
