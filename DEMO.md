# DEMO — what to record, and exactly what to say

**Bottom line first:** ship a **text-mode** demo today. A live phone call is not available —
Twilio/Deepgram/ElevenLabs credentials are unconfigured and the audio path has never carried a
call, so any "live voice" claim would be false. Text mode still shows the interesting part: a
local model driving a clinical script through tools while deterministic rules decide
escalation.

## What can be shown right now

| #   | demo                                                   | works today             | what it proves                                                                               |
| --- | ------------------------------------------------------ | ----------------------- | -------------------------------------------------------------------------------------------- |
| A   | CLI role-play against local omlx — `npm run demo:call` | ✅ (no database needed) | real model + real orchestrator: tools, escalation, staff summary                             |
| B   | Same, scripted — `npm run demo:call -- --mock`         | ✅                      | deterministic plumbing showcase; say "scripted, not the model"                               |
| C   | Escalation walkthrough in code + eval output           | ✅                      | rules, not the model, own the safety decision                                                |
| D   | Browser demo at `http://localhost:3000/`               | ❌ blocked              | needs reachable, migrated Postgres; the server exits at boot today (BUILD_REPORT issues 1–2) |
| E   | `POST /calls/outbound` → your phone                    | ❌ deferred (P2)        | needs Twilio + Deepgram + ElevenLabs keys and a public tunnel                                |
| F   | Live-audio barge-in                                    | ❌ deferred (P2)        | unit-tested only (`clear` frame + TTS abort), never dialled                                  |

**Wart to expect in A and B:** when the model (or the scripted mock) answers with text _and_
a tool call in one response, the current code drops the text and the turn prints
`I'm sorry, could you say that again?` (BUILD_REPORT issue #3 — visible in ~70 % of mock
turns). Either fix it before recording, or narrate it: _"that line is a known defect in the
tool-call turn, not the model refusing."_ Do not cut it silently — the value of this demo is
an honest picture of state.

## Pre-flight (five minutes before recording)

```bash
cd ~/Projects/clinical_voice_agent
npm install
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/v1/models   # expect 200
npm run typecheck && npm test                                                # green on camera
npm run eval -- --mock                                                       # 15/15 in ~1 s: good b-roll
```

Only if you want the browser demo or `db:seed` in the shot — both need a **migrated**
database, and neither works on a fresh clone:

```bash
# 1. .env ships DATABASE_URL with the placeholder password *** — the compose role is
#    `postgres`, so edit .env to match. No volume reset and no ALTER USER needed: the
#    container already accepts `postgres` (verified 03 Nov).
# 2. migrations were never generated, so generate once, then apply and seed:
npm run db:generate && npm run db:migrate && npm run db:seed
npm run dev         # then open http://localhost:3000/
```

If step 2 has not been done before you hit record, the server prints `listening` and exits
seconds later. That is issues #1/#2, not a model problem — fall back to Demo A.

On-screen hygiene: drop the terminal font one notch, close `.env` (it holds a live key), keep
`LLM_API_KEY` out of frame, and leave the "synthetic patients only" banner visible — it is a
feature, not decoration.

---

## Demo A — the one to record (≈6 minutes)

Start it with the real model and the noise turned down:

```bash
LOG_LEVEL=warn npm run demo:call
```

### Part 1 — a clean call (0:00 – 3:45)

| time | you type                                           | what should happen                                                                                                                     | what to say                                                                                                                                                                                         |
| ---- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00 | —                                                  | banner: `script post_discharge_followup@1 · patient Jordan Ellis (SYNTHETIC)`                                                          | "Everything here is invented — synthetic patient, synthetic discharge summary. What's real is the control flow."                                                                                    |
| 0:20 | —                                                  | the agent greets you unprompted                                                                                                        | "That greeting came from step one of a YAML script. The model never chooses which step is next — a state machine does."                                                                             |
| 0:35 | `yes, this is Jordan`                              | `record_identity_verification` fires, identity step completes                                                                          | "Identity became a typed fact, not a line in a chat log. Typed facts are what rules can read."                                                                                                      |
| 1:00 | `my leg hurts about a 6 out of 10`                 | `record_symptom(pain, severity 6)` → `pain_score = 6`                                                                                  | "Six out of ten became a canonical number. That's the difference between a transcript and a chart."                                                                                                 |
| 1:30 | `my temperature is 101.5`                          | `record_vital(temperature_f, 101.5)` → rule `fever_high` matches **urgent**: advisory appended, escalation row written, call continues | "The model just reported a number; it decided nothing. A rule in YAML — `fever_f >= 100.4` — recorded the escalation and added the 'call 911 if it worsens' line, and the conversation carries on." |
| 2:15 | `/status`                                          | prints `step: … · escalations: fever_high/urgent`                                                                                      | "Escalation is queryable state, not a vibe in the transcript."                                                                                                                                      |
| 2:30 | `I took the antibiotics but they make me nauseous` | `record_medication_adherence(taken:true, issues:…)` → `medication_issues`                                                              | "The nausea lands in `medication_issues`, and the staff summary picks it up at the end."                                                                                                            |
| 3:00 | `yes, Thursday morning works`                      | `schedule_followup_callback` → `followup_confirmed`, a `next_steps` line                                                               | "That callback is a row in `followup_callbacks`, not a promise buried in prose."                                                                                                                    |
| 3:20 | `/end`                                             | summary block: outcome, canonical fields, escalations, one-line staff summary, p50/p95 (labelled text mode)                            | "This is what a nurse reads after the call: outcome, symptoms with numbers, medication issues, escalations, next steps."                                                                            |

### Part 2 — the safety moment (3:45 – 5:00)

Start a fresh call (`npm run demo:call` again) so the contrast is clean.

| time | you type                                             | what should happen                                                                                                                                                                                                          | what to say                                                                                                                                                                                                      |
| ---- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3:45 | _(after the greeting)_ `I have pressure in my chest` | rule `chest_pain` matches **emergent**: the model's drafted reply is replaced by _"That sounds urgent. Please hang up and call 911 now. I am alerting your care team."_, remaining steps are skipped, `outcome = escalated` | "Whatever the model was about to say just got overwritten by a deterministic rule. Sampling temperature never gets to decide this one."                                                                          |
| 4:30 | _(third call)_ give a wrong date of birth twice      | `identity_verification` exhausts `max_attempts: 2`, `on_failure: warm_transfer_to_staff` → _"I'm going to have a member of our care team call you back shortly…"_, `outcome = escalated`                                    | "Failure handling is script configuration, not improvisation: two attempts, then hand it to a human."                                                                                                            |
| 5:00 | —                                                    | split screen: `eval-results.md` and `call_scripts/post_discharge_followup.yaml`                                                                                                                                             | "Fifteen scenarios pass — but that's the scripted mock, so it proves plumbing, not model quality. The real-model eval is the next gate, and the gaps in `BUILD_REPORT.md` are what sits between here and there." |

**Say that last line.** A demo that ends on the gaps is worth more than one that ends on a
green checkmark.

### Optional 60-second addendum

Re-run `npm run eval -- --mock` and point at two things: the report's own second line —
`Mode: mock — plumbing check only` — and lines 20–24 of the call script, the four escalation
rules. The audience should leave understanding that `evals/ground_truth/index.json` and those
YAML rules speak the same vocabulary: `fever_f`, `chest_pain`, `shortness_of_breath`,
`identity_verified`. That shared vocabulary is why the harness can grade the agent at all.

---

## Demo B — the browser page (only once Postgres works)

```bash
npm run dev
open http://localhost:3000/
```

Press **Start synthetic call**, type the same lines as Demo A, and narrate the right-hand
panel as it fills: current step, outcome, live p50/p95, the escalation list turning red, and
the staff summary when the call ends. The page's amber banner — _"Text transport only …
nothing measured on this page is a real-audio number"_ — is the honesty device; keep it in
frame rather than cropping it out.

If the page sits on "checking /healthz…", the server never came up: it is issue 1–2
(migrations + credentials), not the browser.

## Demo E — the live phone call (P2; placeholder until it exists)

Not recordable today. Preconditions in order:

1. Twilio number with `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`;
   `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` (or Deepgram Aura) for voice-out;
   `DEEPGRAM_API_KEY` for voice-in.
2. Public tunnel: `ngrok http 3000`, then `PUBLIC_HOST=<xxx>.ngrok-free.app` and restart.
3. `POST /calls/outbound {"patientId":"<id from GET /patients>"}` → Twilio rings your mobile.
4. Recording script: identify by DOB → report a fever → let it finish the steps → hang up.
   Then a second call where you interrupt mid-sentence to show **barge-in** (a Twilio `clear`
   frame drops queued audio and the in-flight TTS request is aborted).
5. Report per-turn `call_turns.latency_ms` as p50/p95 **audio** numbers, replacing today's
   text-mode figures, and state the number that called you.
6. Show the triad that proves the audio path reached the same brain: the transcript rows,
   `GET /escalations/open`, and the staff summary.

Until that exists, this section is the placeholder — labelled as one, on purpose.

## What can go wrong mid-recording (and the line to use)

| symptom                                                                                                    | cause                                                                                                    | what to say / do                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Several turns in a row print `I'm sorry, could you say that again?`                                        | issue #3: text returned alongside a tool call is dropped                                                 | "Known defect in the tool-call turn — the fact still got recorded; the sentence didn't survive. It's issue #3 in the build report." Then continue, or re-record after the fix.                                                     |
| Long pause before a reply                                                                                  | local inference on a shared GPU; client retries with backoff on 5xx/timeout                              | "That pause is the whole argument for local-model latency work — it's what the p95 number will capture."                                                                                                                           |
| The model rambles or restates itself                                                                       | reasoning-preamble / verbosity from the checkpoint                                                       | "We strip reasoning preamble before it reaches the caller; this is why that strip is load-bearing."                                                                                                                                |
| It says _"I'm sorry, could you say that again?"_ after `my temperature is 101.5` and no escalation appears | the model recorded the fever as a symptom instead of `record_vital`                                      | This is a **finding, not a failure** — narrate it: "The rule only sees canonical fields. If the model files the fever in the wrong place, the rule stays silent — that's exactly what the extraction-F1 metric exists to measure." |
| `ECONNREFUSED`/`28P01` when starting the server                                                            | no migrations applied, and `.env` carries the `***` placeholder password instead of the compose password | Don't debug on camera. Use Demo A (in-memory repos). The fix is one `.env` line plus `npm run db:generate && npm run db:migrate` — seconds, but do it before you record.                                                           |
| Escalation webhook configured but nobody got paged                                                         | the webhook is best-effort and failures are swallowed by design                                          | "The database row is the guarantee; the webhook is a nicety. That ordering is deliberate."                                                                                                                                         |

**Backup plan:** pre-record one clean 90-second pass of Part 1 + the chest-pain moment. If the
live model misbehaves during the real take, cut to the backup and say so.

## 30-second crib sheet (if you only remember one thing)

1. "Synthetic patients, invented discharge summaries — nothing here touches PHI."
2. "A YAML script holds the steps and the red-flag rules; code owns the cursor."
3. "The model writes facts through seven typed tools; it can propose an escalation but cannot
   trigger one."
4. "`fever_f >= 100.4` → urgent: advise and finish. `chest_pain` → emergent: say the 911 line
   and stop. Rules, decided deterministically after every turn."
5. "Escalation writes a database row before any webhook, so nothing is silently swallowed."
6. "Latency today is text mode. Audio numbers come with P2."
7. "15/15 passing is the scripted mock — plumbing, not quality. Real-model eval plus the four
   P0 gaps in `BUILD_REPORT.md` are what's next."

## Recording logistics

- 1600×1000 or larger, 30 fps, terminal font ≥ 16 px, dark theme (the demo page is dark).
- Cap it at **7 minutes**; the beat sheet above lands at ~5:00 with buffer.
- Filename: `clinical_voice_agent_demo_YYYY-MM-DD.webm`, and paste the beat sheet timestamps
  into the Loom description so reviewers can jump to the escalation moment.
- Record the terminal and the browser in two separate takes — it makes editing the failure
  takes trivial.
- Before uploading: confirm no `.env`, no API keys, no Twilio numbers from a real account in
  any frame, and that `eval-results.md` on screen is the mock run you intend to show.
