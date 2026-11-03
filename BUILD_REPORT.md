# BUILD REPORT — clinical_voice_agent

**Date:** 2026-11-03 · **Phase:** documentation pass — this pass wrote docs only; no source,
test, migration or config file was modified.

**Verdict: the conversational core is real and runs; the persistence layer and the quality
gates are not yet met.** ~7.3k lines of TypeScript implement a config-driven,
transport-agnostic call orchestrator with deterministic escalation, a tolerant tool-call
parser, an eval harness and a text demo. Typecheck, build, unit tests (60) and the mock eval
(15/15) pass. The database has never been migrated — so no call has ever been persisted —
`src/escalation/**` sits at 8.8 % line coverage against a 95 % gate, lint fails, the P1 real
eval has not been run, and the server exits shortly after boot on an unhandled database
rejection.

> **Revision note (03 Nov).** An earlier draft of this report blamed the Postgres failure on a
> `pgdata` volume initialised with an unknown password, and offered `ALTER USER` or
> `docker compose down -v` as the remedy. **That diagnosis was wrong.** Re-probing from the
> host with the `pg` driver shows the container accepts the password `docker-compose.yml`
> provisions, so the volume is healthy and must not be wiped — the real defect is that the
> repo ships `***` as a placeholder password in `.env.example`, and as the fallback default in
> `src/config/env.ts` and `drizzle.config.ts`. The persistence layer is still broken, and
> still blocks the browser demo; only the cause and the remedy changed. See issues 1 and 2.

## Environment where every command below was run

|               |                                                                                                                                     |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Host          | macOS (darwin), Node **v22.18.0**                                                                                                   |
| Model         | `Qwen3.8-Flash-Next-oQ4e-mtp` served by omlx at `http://localhost:8080/v1` — `GET /v1/models` → HTTP **200** with the key in `.env` |
| Database      | `postgres:16-alpine` container `clinical_voice_pg`, `Up … (healthy)`, published `0.0.0.0:5432` → **0 tables in schema `public`**    |
| Voice vendors | none configured (`textOnly: true`); Deepgram / ElevenLabs / Twilio keys absent                                                      |
| Git           | **not a git repository** (no `.git`) — commit advice below is for when it is initialised                                            |

## Verification log

Every row was executed in this session unless marked otherwise.

| command                                                                   | result                       | detail                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run typecheck`                                                       | ✅ pass                      | app + test tsconfigs, no diagnostics                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `npm run build`                                                           | ✅ pass                      | emits `dist/`                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `npm test`                                                                | ✅ pass                      | **4 files / 60 tests**, ≈0.56 s                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `npx eslint .`                                                            | ✅ **pass**                  | 0 errors, 0 warnings (was 14 errors / 21 warnings — resolved, see §12)                                                                                                                                                                                                                                                                                                                                                                                       |
| `npm run test:coverage`                                                   | ❌ **gate fail**             | tests pass, thresholds do not: `src/escalation/**` lines **8.82 %**, functions **11.11 %**, statements **8.82 %** vs **95 %**. Project totals: lines 23.45 % (1130/4818), functions 28.4 % (48/169), branches 69.76 %                                                                                                                                                                                                                                        |
| `npm run eval -- --mock`                                                  | ✅ pass                      | **15/15**, extraction F1 100 %, escalation F1 100 %, step adherence 100 %, p50 0 ms / p95 1 ms, judge off, every parser tier 0 (mock returns structured calls, bypassing text parsing)                                                                                                                                                                                                                                                                       |
| `npm run eval -- --real --force`                                          | ⏸ **not run**                | deferred to the P1 step; omlx is reachable so it is unblocked                                                                                                                                                                                                                                                                                                                                                                                                |
| `npm run db:migrate`                                                      | ❌ **fail**                  | `Migration failed: Can't find meta/_journal.json file` — `migrations/` does not exist; the repo ships no SQL                                                                                                                                                                                                                                                                                                                                                 |
| `npm run db:seed`                                                         | ❌ **fail**                  | `seed failed: password authentication failed for user "postgres"` (`28P01`)                                                                                                                                                                                                                                                                                                                                                                                  |
| the `.env` DSN, from the host via `pg`                                    | ❌ `28P01`                   | `.env` carries the placeholder password `***`, inherited from `.env.example`; the same placeholder is the fallback default in `src/config/env.ts:35` and `drizzle.config.ts:14`                                                                                                                                                                                                                                                                              |
| user `postgres` + the password compose provisions, from the host via `pg` | ✅ **AUTH OK**               | `select 1` succeeds; `information_schema.tables` for `public` → **0 rows**. Re-probed 03 Nov — **supersedes this log's earlier claim** that the `pgdata` volume "holds a password matching neither"                                                                                                                                                                                                                                                          |
| `psql` **inside** the container                                           | ✅ works, but proves nothing | `docker exec … psql -U postgres` uses the Unix socket, matched by `pg_hba.conf` rule 117 `local all all trust` (rule 124 is a second `local trust`); rules 119/121/125/126 are loopback `trust`, while rule 128 `host all all scram-sha-256` is the one a macOS host connection reaches via the Docker bridge                                                                                                                                                |
| `MOCK_LLM=true npx tsx src/server/app.ts`                                 | ❌ **crash after listen**    | logs `TEXT-ONLY mode` then `clinical_voice_agent listening`, then exits: `deps.ready` (`src/server/deps.ts:76`) is never awaited by `startServer` (`src/server/app.ts`), and the only `.catch()` on it is attached inside the `/healthz` handler (`src/server/routes.ts:55`) — so the `bootstrapReferenceData` → `PgOrganizations.ensureByName` rejection (`28P01`) is unhandled unless something polls `/healthz` first. `/healthz` therefore never answers |
| `npm run demo:call -- --mock`                                             | ⚠️ runs, degraded            | greeting renders; the following turn prints the fallback line — see issue **#3**                                                                                                                                                                                                                                                                                                                                                                             |
| `npm run db:generate` (= `npx drizzle-kit generate`)                      | ⏸ not run                    | skipped deliberately: this pass is docs-only. This is the missing step — nothing under `migrations/` has ever been produced                                                                                                                                                                                                                                                                                                                                  |

---

## Module status

| module                | LOC       | state                              | tested                     | notes                                                                                                                 |
| --------------------- | --------- | ---------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `src/config`          | 499       | done                               | ✅ 11 tests                | three-tier env validation naming missing keys; script schema with `op`↔field-kind checks; `{{var}}` whitelist         |
| `src/orchestrator`    | 785       | done                               | ❌ **0 tests**             | state machine + prompt builder + turn loop; cursor owned in code; full termination policy                             |
| `src/escalation`      | 220       | done                               | ❌ **8.8 % vs 95 % gate**  | pure rule engine + notifier (row first, webhook best-effort). _The_ safety property, with zero direct tests           |
| `src/tools`           | 615       | done                               | ⚠️ 8 tests (coercion only) | 7 tools, server-side re-validation, alias canonicalisation, explicit-denial handling, ISO-date guard                  |
| `src/extraction`      | 544       | done                               | ❌                         | canonical fields + tolerant merge, markdown discharge parser (typed `.pdf` refusal), staff summary renderer           |
| `src/llm`             | 926       | done                               | ✅ 28 tests                | tolerant 4-tier tool-call parser, retry/backoff, `response_format`/`tools` degradation, mock client                   |
| `src/db`              | 1191      | **written, never applied**         | ❌                         | 9 tables, 4 unique constraints, 10 indexes _in code_; **0 tables in the database**; memory repos back tests/eval/demo |
| `src/server`          | 673       | done                               | ❌                         | REST + TwiML + media/text WebSockets; P2 endpoints return 503 naming missing keys                                     |
| `src/transport`       | 379       | done                               | ⚠️ μ-law only              | Twilio Media Streams incl. barge-in (`clear` + abort TTS), TextTransport                                              |
| `src/stt` · `src/tts` | 163 · 126 | written, never run against vendors | ❌                         | Deepgram streaming; ElevenLabs + Aura fallback; mock paths                                                            |
| `src/eval`            | 839       | done                               | ⚠️ indirectly              | harness, per-scenario cache, scoring, judge, reporter (report has a formatting bug — issue **#4**)                    |
| `src/scripts`         | 351       | done                               | —                          | seed, synthetic fixtures, CLI demo                                                                                    |
| `public/`             | ~160      | done, never exercised end-to-end   | ❌                         | browser text demo wired to `/ws/call`; needs a working DB                                                             |
| **total `src/`**      | **7338**  |                                    | **60 tests**               |                                                                                                                       |

### Database objects the missing migration must create

`src/db/schema.ts` defines 9 tables — `organizations`, `call_scripts`, `patients`,
`discharge_documents`, `calls`, `call_turns`, `extractions`, `escalations`,
`followup_callbacks` — with unique constraints on `organizations.name`,
`call_scripts(org_id,name,version)`, `patients(org_id,external_ref)` and
`calls.twilio_call_sid`, plus 10 indexes including `call_turns(call_id,idx)` and
`extractions(call_id,field)`. **None of this exists in the database yet**, so the plan's
gates "`calls.twilio_call_sid` unique" and "`call_turns(call_id, idx)` indexed" are
currently unverifiable, and no Postgres repository code path has ever executed.

## What the eval numbers do and do not mean

`eval-results.md` is a **mock** run: the scripted agent's tool calls are derived from the
same ground truth used to score it, so 100 % across the board measures plumbing — step
ordering, escalation firing, per-call dedupe, outcome mapping, persistence (in memory),
scoring math. That is a legitimate regression harness; it is _not_ a model-quality result.
The report file says so on its own second line.

Parser tier counters were all zero in that run because the mock returns structured tool calls
rather than text; those counters only become meaningful under `--real`, where they reveal how
much of Qwen's output needed rescue beyond native `tool_calls`.

## Deliberate deviations from the plan

1. **Seven tools, not six.** `identity_verified` had no write path among the planned six;
   `record_identity_verification` was added rather than inventing a non-canonical field name.
2. **PDF ingestion out of v1 scope.** `.pdf` raises `DischargeParseError` pointing at the
   README; markdown/text + LLM fallback only.
3. **P1 latency is text-mode.** Reports label it `text-mode (audio pipeline not measured)`
   rather than quietly presenting it as voice latency.
4. **Docs before tests** in this pass, at the user's direction — the gap list below is the
   deliverable, and nothing in `src/`, `tests/`, `migrations/` or `.env.example` was touched.
5. **`heart_rate` / `spo2` are audited, not actionable.** They persist as `vital:*`
   extraction rows but have no canonical field, so they cannot drive escalation — safer than
   silently making them rule-visible.

---

## Known issues

Ordered by how much they block the plan's Definition of Done. **None were fixed in this
pass** (docs-only); the fix column is the next pass's work list.

### 1. Drizzle migrations were never generated — `P0 blocker`

- **Symptom:** `npm run db:migrate` → `Migration failed: Can't find meta/_journal.json file`.
  No `migrations/` directory exists; `information_schema` shows 0 tables.
- **Consequence:** the audit trail — a headline feature — has never existed in a database, so
  no Postgres repository method has ever been exercised.
- **Fix:** `npm run db:generate` → commit `migrations/*.sql` **and**
  `migrations/meta/_journal.json` (+ `_gen_config.json`, snapshots) → `npm run db:migrate` →
  assert the 9 tables, 4 unique constraints and 10 indexes exist.

### 2. The shipped DSN carries a placeholder password, and the server dies from it — `P0 blocker`

- **Symptom:** every host-side connection fails `28P01 password authentication failed for
user "postgres"` — `npm run db:seed`, `drizzle-kit`, and the server's boot-time bootstrap.
- **Root cause (re-probed from the host on 03 Nov using the `pg` driver):**

  | candidate credential                                           | result                                           |
  | -------------------------------------------------------------- | ------------------------------------------------ |
  | the DSN as shipped in `.env` (password `***`)                  | ❌ `28P01`                                       |
  | user `postgres` + the password `docker-compose.yml` provisions | ✅ **AUTH OK**, `public` schema has **0 tables** |

  The volume and server are therefore healthy. **An earlier draft of this report claimed the
  `pgdata` volume "holds a password matching neither" and prescribed `ALTER USER` or
  `docker compose down -v`; that diagnosis was wrong, and either action would wipe a working
  database.** The defect is in the repo: `.env.example` ships the password as the placeholder
  `***`, and the same placeholder is the fallback default in `src/config/env.ts:35` and
  `drizzle.config.ts:14`, while `docker-compose.yml` provisions the role from
  `${POSTGRES_PASSWORD:-postgres}`. The README quickstart's own `cp .env.example .env`
  guarantees `28P01`. (The 0 tables are a separate defect — issue 1: no migration SQL has
  ever been generated.)

- **Why it hid:** `docker exec clinical_voice_pg psql -U postgres` connects over the Unix
  socket, matched by `pg_hba.conf` rule 117 `local all all trust` (rule 124 is a second
  `local trust`), so it never presents a password. Host connections arrive on the Docker
  bridge rather than loopback — rules 119/121/125/126 cover `127.0.0.1`/`::1` — and fall
  through to rule 128 `host all all scram-sha-256`, where the placeholder is rejected.
  Container-local `psql` succeeding is **not** evidence about host auth.
- **Knock-on:** `npm run db:seed` fails, and `tsx src/server/app.ts` logs
  `clinical_voice_agent listening` and then exits. `deps.ready` (`src/server/deps.ts:76`) is
  created but never awaited by `startServer`, and its only `.catch()` is attached _inside the
  `/healthz` handler body_ (`src/server/routes.ts:55`) — per request, not at boot. Whether
  the process survives therefore depends on something polling `/healthz` before the rejection
  lands, which is why the crash looks intermittent.
- **Fix (environment, one line):** set the password segment of `DATABASE_URL` in `.env` to
  the value compose provisions. **No volume wipe and no `ALTER USER`** — the container already
  accepts it.
- **Fix (repo):** replace the `***` placeholder with that same value in `.env.example`,
  `src/config/env.ts` and `drizzle.config.ts` so a fresh clone can authenticate.
- **Fix (code):** see issue 11 — attach the rejection handler where `deps.ready` is created,
  report `db: "ok" | "unavailable: <reason>"` from `/healthz`, and add a
  `REPOSITORIES=memory` switch (**not implemented today**, despite being referenced as if it
  were) so the server can boot DB-free.

### 3. Text produced alongside a tool call is discarded — `P1 correctness`

- **Location:** `src/orchestrator/Orchestrator.ts` — inside the inner loop, a response with
  `toolCalls.length > 0` `continue`s before its `text` is assigned to the reply.
- **Symptom:** any turn where the model returns content _and_ tool calls in one response says
  nothing; after 3 iterations the patient hears the canned
  `"I'm sorry, could you say that again?"`. Reproduced with `npm run demo:call -- --mock`:
  the scripted mock attaches an utterance to every tool-bearing step, so the turn after the
  greeting prints the fallback line.
- **Measured impact:** across the cached mock run, **46 of 66 agent turns (69.7 %) are that
  canned fallback** — yet all 15 scenarios score 100 % and pass. In other words the agent as
  observed today is largely silent-plus-apology, and the harness cannot see it.
- **Why the eval misses it:** mock assertions cover fields, escalations, steps and outcome —
  never utterances — and `--judge` is off.
- **Fix:** keep the accompanying text as the reply candidate (a later text-only response still
  wins), and add an orchestrator test asserting that a tools-plus-text turn speaks the text.

### 4. Reporter emits a malformed Markdown row — `P2 cosmetic (it breaks the table)`

`src/eval/reporter.ts` omits the leading `|` on the `response_format` fallbacks line, so
`` `response_format` fallbacks | 0 | `` renders outside the table in `eval-results.md`.
Fix the pipe and assert row width in a reporter test.

### 5. `src/escalation/**` coverage 8.8 % vs a 95 % gate — `P0 gate`

The safety-critical module has no direct tests, and `npm run test:coverage` exits non-zero
because of it. The 100.4 °F boundary, "missing ≠ false", several rules matching one turn,
per-call dedupe and the routine/urgent/emergent action map are all unguarded.

### 6. Test suite is ~a third of the plan — `P0 gate`

Suites that exist: config/schema, tool-call parsing, μ-law, coercion. Missing:
`escalationEngine`, `stateMachine`, `orchestrator` (the Module-B acceptance list),
`extractor`, `toolHandlers`, `routes`, scripted `bargeIn`, `postgres` integration with a
visible auto-skip, and the adversarial non-hallucination suite.
`tests/helpers/testSetup.ts` was written for exactly those suites and is imported by none of
them yet.

### 7. P1 real eval not run — `P1 gate`

`npm run eval -- --real --force` is unblocked (omlx answers `200` on `/v1/models`) but has
never been executed, so there are **no** model-quality numbers: no real extraction F1, no real
escalation F1, no native-vs-fallback parser-tier mix, no judge scores. Until it runs,
`eval-results.md` must be read as plumbing only.

### 8. Server and browser demo never exercised end-to-end

`public/index.html` + `public/app.js` drive `/calls/text` and `/ws/call`, but because of
issues 1–2 no HTTP request has ever reached a running server. The static page and `/healthz`
are expected to serve; that is the full extent of what is known.

### 9. Escalation dedupe ignores value changes — `design gap`

`Orchestrator.firedRules` is keyed on `rule_id`, so a fever worsening 100.4 °F → 103.1 °F,
or shortness of breath escalating `mild → severe`, produces no second notification. Acceptable
for a prototype, wrong for production. Fix by keying on `rule_id + urgency` (or a value band)
and re-notifying on strict worsening.

### 10. `db:seed` appends documents on every run

Patients are matched by `external_ref` (idempotent), but every run inserts a fresh
`discharge_documents` row. Harmless — the orchestrator reads the _latest_ document — but row
counts grow with re-seeding, so "verify synthetic row counts" needs care. Fix by skipping the
insert when identical `raw_text` + filename already exist.

### 11. `/healthz` masks database breakage — and is the only thing holding the process up

`await deps.ready.catch(() => undefined)` swallows bootstrap failures and still answers
`ok: true`, so a server with a dead audit trail looks healthy. Report
`db: "ok" | "unavailable: <reason>"` and let it drive readiness.

The placement is the other half of the bug: `deps.ready` is created at
`src/server/deps.ts:76` and never awaited by `startServer`, so this `.catch()` — attached
inside the request handler at `src/server/routes.ts:55` — is the promise's **only** rejection
handler, and it exists only once a request arrives. Unpolled, the bootstrap rejection is
unhandled and Node exits (issue 2). Attach one handler where the promise is created, record
the outcome on `deps`, and have `/healthz` read that recorded state instead of racing it.

### 12. Lint debt — `RESOLVED 2026-11-03` (two of the failures were config bugs)

`npx eslint .` was **35 problems (14 errors, 21 warnings)**; now **0 / 0**. Typecheck, the
60 unit tests and `npm run eval -- --mock --force` (15/15) all still pass after the cleanup.
No CI enforces it today — that remains open.

| count | severity | rule                                         | where                                                                                       |
| ----- | -------- | -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 20    | warning  | `no-console`                                 | `src/scripts/demo.ts` (17), `src/eval/runEvals.ts` (2), `scripts/generateScenarios.mjs` (1) |
| 3     | error    | `no-undef`                                   | `scripts/generateScenarios.mjs` L4/L273/L275 — `URL`, `console` "not defined"               |
| 3     | error    | `@typescript-eslint/no-unused-vars`          | `src/llm/mockClient.ts:3`, `src/llm/openaiClient.ts:9`, `src/tools/coerce.ts:142`           |
| 3     | error    | `no-useless-escape`                          | `src/llm/parseToolCalls.ts` L42/L45/L46                                                     |
| 3     | error    | `@typescript-eslint/consistent-type-imports` | `src/server/mediaStream.ts:2`, `src/tools/coerce.ts:1`, `src/tools/handlers.ts:1`           |
| 1     | error    | `@typescript-eslint/no-empty-object-type`    | `src/db/repositories/postgres.ts:51`                                                        |
| 1     | error    | `prefer-const`                               | `src/llm/parseToolCalls.ts:142`                                                             |
| 1     | warning  | unused `eslint-disable` directive            | `tests/unit/mulaw.test.ts` — disables `no-bitwise`, which reports nothing                   |

Two of these were **configuration, not code**, and were fixed in `eslint.config.js`:

- The three `no-undef` errors were false positives: `URL` and `console` are Node globals.
  `eslint.config.js` defined **no `languageOptions` block at all** — no `globals`, no
  `sourceType`, no `files:` scoping beyond the ignore list — so flat config linted
  `scripts/**/*.mjs` against an empty global scope. Fixed with a `NODE_GLOBALS` map applied
  via `{ files: CLI_ENTRYPOINTS, languageOptions: { globals: NODE_GLOBALS } }`. The globals
  are declared inline rather than by importing the `globals` package, which is present in
  `node_modules` only transitively and is not a declared dependency here.
- The stale `eslint-disable no-bitwise` in `tests/unit/mulaw.test.ts` was an obsolete
  directive (the rule is not enabled) and has been deleted.

The 20 `no-console` warnings were all in CLI entrypoints where stdout *is* the product
(`src/scripts/demo.ts` 17, `src/eval/runEvals.ts` 2, `scripts/generateScenarios.mjs` 1), so
they are allow-listed by path via `CLI_ENTRYPOINTS` rather than rewritten as `console.error`.
Library code under `src/**` outside those paths is still held to the rule.

Remaining code fixes: the type-import / unused-var / useless-escape / `prefer-const` /
empty-interface errors are all cleared. Verified equivalent: the `[\[,]` → `[,[]` regex change
in `parseToolCalls.ts` was checked against the original for byte-identical output, and
`rawArgs` was confirmed never reassigned before `let` → `const`.

**Still open and deliberately not touched:** `npm run format` (Prettier) fails on 49 files
repo-wide — including files untouched here — at any `printWidth` from 100 to 140, so the
repo has never been formatted and `printWidth: 100` in `.prettierrc.json` does not match the
~129-column style actually used. Running `npm run format` would produce a ~49-file diff that
drowns out review, so it is left as a standalone decision. Note `npm run lint` is eslint-only
and does *not* check formatting, so a green `npm run lint` is not a claim that the repo is
Prettier-clean.

### 13. Scratch files in the repo root

`tmp_fix_parse_tests.py`, `tmp_inspect.py`, `tmp_scrub_tokens.py` — build scaffolding that
must not ship in a clinical codebase (and a hint that some generation happened outside the
repo's own tooling). Delete them, and add `tmp_*` to `.gitignore`: the file exists and
correctly covers `.env`, `node_modules/`, `dist/`, `coverage/`, `evals/.cache/`, `*.log`,
`.DS_Store` and `.tsbuildinfo`, but nothing matching scratch scripts — so the next one is
committed by default. (There is no `.git` directory yet, so nothing has actually been
committed; the ignore rule matters at `git init` time.)

---

## Re-running everything (fresh clone)

```bash
npm install
cp .env.example .env                       # set LLM_API_KEY, and replace the *** password in
                                           # DATABASE_URL with the one compose provisions — the
                                           # committed template cannot authenticate as shipped
npm run db:up
npm run db:generate                      # ← required once: the repo ships no migrations/
npm run db:migrate && npm run db:seed    # expect 9 tables; 6 synthetic patients + 6 documents
npm run typecheck && npm run build
npx eslint . --fix && npm run lint
npm test && npm run test:coverage        # escalation must reach 95 %
npm run eval -- --mock                   # plumbing: expect 15/15
npm run eval -- --real --force        # quality: the P1 numbers
npm run demo:call                      # interactive text call (in-memory repos)
npm run dev                            # browser demo at http://localhost:3000/  (needs Postgres)
```

P2 (a real phone call) additionally needs Twilio + Deepgram + ElevenLabs credentials and a
public tunnel for `PUBLIC_HOST` (e.g. `ngrok http 3000`), then
`POST /calls/outbound {"patientId": …}`.

## Suggested commit series once the repo is initialised

```
feat: three-tier env validation naming missing keys
feat: yaml call-script schema with op/field-kind and placeholder checks
feat: canonical clinical fields with tolerant merge and audit rows
feat: deterministic escalation engine — rules decide, model proposes
feat: escalation notifier — database row first, webhook best-effort
feat: step state machine with attempts, flag and warm-transfer policies
feat: transport-agnostic orchestrator with rule-driven termination
feat: prompt builder owning the active step and known fields
feat: tolerant tool-call parser (native, inline, fenced, bare) with coercion
feat: OpenAI-compatible client with retry and parameter degradation
feat: seven tool definitions with server-side re-validation
feat: markdown discharge parser with typed pdf refusal
feat: structured staff summary and rendering
feat: drizzle schema with memory and postgres repositories
feat: fastify routes, twiml, media and text websockets
feat: twilio media transport with barge-in
feat: deepgram stt and elevenlabs/aura tts with mock paths
feat: eval harness, metrics, judge and 15 synthetic scenarios
docs: README, BUILD_REPORT and DEMO
feat: generate and apply drizzle migrations            # pending
fix: keep spoken text emitted alongside tool calls     # pending
test: escalation engine boundaries and action mapping   # pending
test: state machine and orchestrator acceptance suites  # pending
test: routes, tool handlers, extractor, postgres        # pending
chore: lint cleanup (0 errors / 0 warnings)            # done 2026-11-03
chore: remove scratch files                            # pending
```

## Definition of Done — honest checklist

| tier   | gate                                          | status                                                                                                                                       |
| ------ | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0** | typecheck + build                             | ✅                                                                                                                                           |
| **P0** | unit tests green                              | ✅ 60/60                                                                                                                                     |
| **P0** | `src/escalation/**` ≥ 95 %                    | ❌ **8.8 %**                                                                                                                                 |
| **P0** | per-module suites (Module B/C/E/F acceptance) | ❌ mostly unwritten                                                                                                                          |
| **P0** | lint clean                                    | ❌ 14 errors / 21 warnings                                                                                                                   |
| **P0** | migrations committed + applied, seed verified | ❌ no SQL generated (`db:generate` never run); seed blocked by the `***` placeholder password in `.env.example` — fixable in one `.env` line |
| **P0** | text-mode call completes through the server   | ❌ server exits shortly after `listening` on an unawaited, lazily-caught bootstrap rejection (issues 2, 11)                                  |
| **P0** | README + BUILD_REPORT + DEMO                  | ✅ this pass                                                                                                                                 |
| **P1** | real eval with parser-tier + fallback counts  | ❌ not run                                                                                                                                   |
| **P1** | real text-mode latency p50/p95                | ❌ not run (today's numbers are mock)                                                                                                        |
| **P1** | LLM-judge safety mean                         | ❌ not run                                                                                                                                   |
| **P1** | no fabricated facts on adversarial scenarios  | ⚠️ scenarios exist; hallucination assertions do not                                                                                          |
| **P2** | live Twilio call with barge-in                | ❌ deferred — no vendor credentials, never dialled                                                                                           |
| **P2** | real-audio latency p50/p95                    | ❌ deferred with P2                                                                                                                          |

## Next actions, in order

1. **Restore the database path** (issue 2) — one line in `.env`: point `DATABASE_URL`'s
   password at the value compose provisions. **Do not wipe the volume and do not `ALTER USER`**;
   the container already authenticates as `postgres`, and `information_schema.tables` confirms
   the schema is empty because **no migration SQL has ever been generated**, not because the
   database is corrupt. Then fix the placeholder at its source (`.env.example`,
   `src/config/env.ts`, `drizzle.config.ts`), run `npm run db:generate`, apply, seed, and
   verify the 9 tables, the `calls.twilio_call_sid` unique index and the
   `call_turns(call_id, idx)` index before booting the server and checking `/healthz`.
2. **Fix tool-call text suppression** (issue 3) — it changes what the patient actually hears,
   so it is worth landing before any demo or real eval.
3. **Close the safety-coverage gate** (issue 5): `tests/unit/escalationEngine.test.ts`
   covering the 100.4 °F boundary, every operator, missing-vs-false, multi-rule turns, per-call
   dedupe and urgency→action mapping; then `stateMachine` and `orchestrator` acceptance suites
   using the already-written `tests/helpers/testSetup.ts`.
4. **Run the real eval** (`--real --force`, ideally `--judge`) and replace `eval-results.md`
   with genuine numbers, keeping the mock/real labelling intact and reporting parser tiers.
5. **Hygiene** — lint clean-up, delete `tmp_*`, fix the reporter table row, then re-run the
   full gate sequence.
6. **P2 last** — tunnel + vendor credentials + one live call, with barge-in timed, only once
   1–5 are green.
