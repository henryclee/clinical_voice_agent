# Eval results

Generated: 2026-11-03T19:12:22.936Z
Mode: **mock** — plumbing check only; these numbers are NOT model quality (the mock is handed the ground truth)
LLM: `mock(scripted)` @ in-process
Judge: disabled (pass --judge)

## Aggregate

| metric | value |
| --- | --- |
| scenarios | 15 (15 pass / 0 fail) |
| extraction F1 (per field) | 100.0% |
| escalation F1 | 100.0% |
| step adherence | 100.0% |
| latency p50 | 0 ms (text-mode (audio pipeline not measured)) |
| latency p95 | 1 ms (text-mode (audio pipeline not measured)) |
| judge mean (1-5) | not judged |

## Tool-call parser

| metric | value |
| --- | --- |
| native tool_calls | 0 |
| inline <tool_call> | 0 |
| fenced JSON | 0 |
| bare JSON | 0 |
| coerced quirks | 0 |
| rejected calls | 0 |
`response_format` fallbacks | 0 |
`tools` fallbacks | 0 |

> Parser counters are module-global, so with `--concurrency > 1` they are a
> per-run aggregate, not a per-scenario measurement.

## Per scenario

| id | pass | outcome | extraction F1 | escalation F1 | steps | p95 | judge |
| --- | --- | --- | --- | --- | --- | --- | --- |
| s01_clean_cellulitis | pass | completed (want completed) | 100.0% | 100.0% | 5/5 | 1 ms | - |
| s02_clean_cardiac | pass | completed (want completed) | 100.0% | 100.0% | 5/5 | 1 ms | - |
| s03_clean_postop | pass | completed (want completed) | 100.0% | 100.0% | 5/5 | 1 ms | - |
| s04_fever_urgent | pass | escalated (want escalated) | 100.0% | 100.0% | 5/5 | 1 ms | - |
| s05_chest_pain_emergent | pass | escalated (want escalated) | 100.0% | 100.0% | 2/2 | 0 ms | - |
| s06_fever_and_med_issue | pass | escalated (want escalated) | 100.0% | 100.0% | 5/5 | 0 ms | - |
| s07_identity_wrong_dob | pass | escalated (want escalated) | 100.0% | 100.0% | 1/1 | 1 ms | - |
| s08_identity_no_answer | pass | escalated (want escalated) | 100.0% | 100.0% | 1/1 | 0 ms | - |
| s09_confused_questions | pass | completed (want completed) | 100.0% | 100.0% | 5/5 | 0 ms | - |
| s10_confused_repeats | pass | completed (want completed) | 100.0% | 100.0% | 5/5 | 0 ms | - |
| s11_refusal_early | pass | refused (want refused) | 100.0% | 100.0% | 2/2 | 0 ms | - |
| s12_refusal_late | pass | refused (want refused) | 100.0% | 100.0% | 2/2 | 0 ms | - |
| s13_silence | pass | partial (want partial) | 100.0% | 100.0% | 2/2 | 0 ms | - |
| s14_med_not_in_doc | pass | completed (want completed) | 100.0% | 100.0% | 5/5 | 1 ms | - |
| s15_ambiguous_severity | pass | completed (want completed) | 100.0% | 100.0% | 5/5 | 0 ms | - |

