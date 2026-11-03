/**
 * Call-script config validation. The script is configuration, not code, so the load-time
 * guards are what keep a typo'd escalation rule from silently doing nothing at runtime.
 */
import { describe, expect, it } from 'vitest';

import { parseCallScript, CallScriptError, loadDefaultCallScript } from '../../src/config/loadCallScript.js';
import { ruleTypeIssues, deriveRequiredSteps } from '../../src/config/schema.js';
import { REPO_ROOT } from '../helpers/testSetup.js';

describe('default call script', () => {
  const loaded = loadDefaultCallScript(REPO_ROOT);

  it('loads with ordered steps and derived required steps', () => {
    expect(loaded.script.id).toBe('post_discharge_followup');
    expect(loaded.script.version).toBe(1);
    expect(loaded.script.steps.map((step) => step.id)).toEqual([
      'greeting',
      'identity_verification',
      'symptom_check',
      'medication_review',
      'wrap_up',
    ]);
    expect(loaded.requiredSteps).toEqual(deriveRequiredSteps(loaded.script));
    expect(loaded.requiredSteps).toContain('symptom_check');
  });

  it('declares the safety rules the escalation contract depends on', () => {
    const byId = new Map(loaded.script.escalation_rules.map((rule) => [rule.id, rule]));
    expect(byId.get('chest_pain')?.urgency).toBe('emergent');
    expect(byId.get('severe_sob')?.urgency).toBe('emergent');
    expect(byId.get('fever_high')?.urgency).toBe('urgent');
    expect(byId.get('identity_failed')?.urgency).toBe('routine');
    for (const rule of loaded.script.escalation_rules) expect(ruleTypeIssues(rule)).toEqual([]);
  });

  it('uses only whitelisted interpolation placeholders', () => {
    expect(loaded.script.persona).toContain('{{practice_name}}');
  });

  it('defaults step failure policy to retry x2', () => {
    const greeting = loaded.script.steps.find((step) => step.id === 'greeting');
    expect(greeting?.max_attempts).toBe(2);
    expect(greeting?.on_failure).toBe('retry');
  });
});

describe('parseCallScript guards', () => {
  const base = `
id: test_script
version: 1
persona: A helpful clinical follow-up assistant for the clinic.
steps:
  - { id: greeting, instruction: "Say hello." }
`;

  it('rejects a boolean field compared with gt (rule could never match)', () => {
    expect(() =>
      parseCallScript(`${base}
escalation_rules:
  - { id: bad_bool, when: { field: chest_pain, op: gt, value: 1 }, urgency: urgent, reason: "Impossible rule" }
`),
    ).toThrow(CallScriptError);
  });

  it('rejects an enum value that is not in the canonical vocabulary', () => {
    expect(() =>
      parseCallScript(`${base}
escalation_rules:
  - { id: bad_enum, when: { field: shortness_of_breath, op: eq, value: extreme }, urgency: urgent, reason: "Unknown enum" }
`),
    ).toThrow(CallScriptError);
  });

  it('rejects an unknown canonical field name', () => {
    expect(() =>
      parseCallScript(`${base}
escalation_rules:
  - { id: bad_field, when: { field: blood_sugar, op: gt, value: 200 }, urgency: urgent, reason: "Not canonical" }
`),
    ).toThrow(CallScriptError);
  });

  it('rejects duplicate step ids and duplicate rule ids', () => {
    expect(() =>
      parseCallScript(`
id: test_script
version: 1
persona: A helpful clinical follow-up assistant for the clinic.
steps:
  - { id: greeting, instruction: "Say hello." }
  - { id: greeting, instruction: "Say hello again." }
`),
    ).toThrow(CallScriptError);

    expect(() =>
      parseCallScript(`${base}
escalation_rules:
  - { id: fever_high, when: { field: fever_f, op: gte, value: 100.4 }, urgency: urgent, reason: "First" }
  - { id: fever_high, when: { field: fever_f, op: gte, value: 102 }, urgency: urgent, reason: "Second" }
`),
    ).toThrow(CallScriptError);
  });

  it('rejects an unknown interpolation placeholder', () => {
    expect(() =>
      parseCallScript(`
id: test_script
version: 1
persona: Assistant for {{patient_social_security_number}}.
steps:
  - { id: greeting, instruction: "Say hello." }
`),
    ).toThrow(CallScriptError);
  });

  it('rejects a script with no steps and surfaces readable issues', () => {
    let error: unknown;
    try {
      parseCallScript('id: test_script\nversion: 1\npersona: Assistant persona text here.\nsteps: []\n', 'unit-test');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CallScriptError);
    const scriptError = error as CallScriptError;
    expect(scriptError.origin).toBe('unit-test');
    expect(scriptError.issues.join('\n')).toMatch(/steps/);
  });

  it('accepts a minimal valid script and applies defaults', () => {
    const loaded = parseCallScript(base, 'unit-test');
    expect(loaded.steps[0]?.max_attempts).toBe(2);
    expect(loaded.script.escalation_rules).toEqual([]);
    expect(loaded.requiredSteps).toEqual(['greeting']);
  });
});
