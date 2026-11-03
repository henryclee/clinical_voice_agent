import { writeFileSync, mkdirSync } from 'node:fs';
import YAML from 'yaml';

const OUT = new URL('../evals/scenarios/', import.meta.url);

const P = {
  ellis: { externalRef: 'SYN-0001', firstName: 'Jordan', lastName: 'Ellis', dob: '1968-04-12', phone: '+15550001001' },
  whitfield: { externalRef: 'SYN-0002', firstName: 'Marcus', lastName: 'Whitfield', dob: '1955-09-30', phone: '+15550001002' },
  raman: { externalRef: 'SYN-0003', firstName: 'Priya', lastName: 'Raman', dob: '1960-01-22', phone: '+15550001003' },
  novak: { externalRef: 'SYN-0004', firstName: 'Elena', lastName: 'Novak', dob: '1982-06-05', phone: '+15550001004' },
  osei: { externalRef: 'SYN-0005', firstName: 'Samuel', lastName: 'Osei', dob: '1975-11-17', phone: '+15550001005' },
};

const ALL = ['greeting', 'identity_verification', 'symptom_check', 'medication_review', 'wrap_up'];
const CLEAN = { identity_verified: true, chest_pain: false, shortness_of_breath: 'none', medication_adherent: true, followup_confirmed: true };

export const scenarios = [
  {
    id: 's01_clean_cellulitis',
    title: 'Clean recovery, cellulitis',
    discharge_doc: 'discharge_docs/d01_cellulitis.md',
    patient: P.ellis,
    patient_turns: [
      'yes this is he',
      'no fever, the wound looks clean and dry',
      'soreness is a 2 out of 10',
      'yes, taking the antibiotic on schedule',
      'sounds good, clinic in three days',
    ],
    expected: { extractions: { ...CLEAN, pain_score: 2, wound_concern: false }, escalations: [], required_steps_completed: ALL, outcome: 'completed' },
    notes: 'baseline happy path',
  },
  {
    id: 's02_clean_cardiac',
    title: 'Clean recovery, heart failure',
    discharge_doc: 'discharge_docs/d02_cardiac.md',
    patient: P.whitfield,
    patient_turns: [
      'correct, that is me',
      'a little stiff walking upstairs, no chest pain',
      'no fever',
      'yes, the water pill every morning',
      'cardiology follow up is booked',
    ],
    expected: { extractions: { ...CLEAN, shortness_of_breath: 'mild' }, escalations: [], required_steps_completed: ALL, outcome: 'completed' },
    notes: 'mild shortness of breath must NOT escalate',
  },
  {
    id: 's03_clean_postop',
    title: 'Clean recovery, appendectomy',
    discharge_doc: 'discharge_docs/d04_postop.md',
    patient: P.novak,
    patient_turns: [
      'yes, speaking',
      'incision looks fine, no redness',
      'pain is a 4 out of 10',
      'taking the tablets, no problems',
      'I will come back in two weeks',
    ],
    expected: { extractions: { ...CLEAN, pain_score: 4, wound_concern: false }, escalations: [], required_steps_completed: ALL, outcome: 'completed' },
    notes: 'baseline post-op',
  },
  {
    id: 's04_fever_urgent',
    title: 'Fever 101.5F -> urgent',
    discharge_doc: 'discharge_docs/d01_cellulitis.md',
    patient: P.ellis,
    patient_turns: [
      'yes it is me',
      'my temperature was 101.5 last night',
      'no chest pain and breathing is fine',
      'the antibiotic makes me a bit nauseous',
      'ok, I will watch it closely',
    ],
    expected: {
      extractions: { identity_verified: true, fever_f: 101.5, chest_pain: false, shortness_of_breath: 'none', medication_adherent: true, medication_issues: ['the antibiotic makes me a bit nauseous'], followup_confirmed: true },
      escalations: ['fever_high'],
      required_steps_completed: ALL,
      outcome: 'escalated',
    },
    notes: 'urgent: advise, finish the script, close escalated',
  },
  {
    id: 's05_chest_pain_emergent',
    title: 'Chest pain -> emergent short-circuit',
    discharge_doc: 'discharge_docs/d02_cardiac.md',
    patient: P.whitfield,
    mock_end_call_at: 'none',
    patient_turns: ['yes, this is Marcus', 'I have this pressure in my chest right now', 'it started about an hour ago'],
    expected: {
      extractions: { identity_verified: true, chest_pain: true },
      escalations: ['chest_pain'],
      required_steps_completed: ['greeting', 'identity_verification'],
      outcome: 'escalated',
    },
    notes: 'emergent terminates mid-call: symptom/med/wrap steps are never reached',
  },
  {
    id: 's06_fever_and_med_issue',
    title: 'Fever plus medication problem',
    discharge_doc: 'discharge_docs/d01_cellulitis.md',
    patient: P.ellis,
    patient_turns: [
      'yes correct',
      'fever of 101.5 this morning',
      'no chest pain',
      'I stopped the antibiotic, it made me sick',
      'alright, thank you',
    ],
    expected: {
      extractions: { identity_verified: true, fever_f: 101.5, chest_pain: false, medication_adherent: false, medication_issues: ['I stopped the antibiotic, it made me sick'], followup_confirmed: true },
      escalations: ['fever_high'],
      required_steps_completed: ALL,
      outcome: 'escalated',
    },
    notes: 'mirrors the PLAN ground-truth example',
  },
  {
    id: 's07_identity_wrong_dob',
    title: 'Identity failure: wrong DOB twice',
    discharge_doc: 'discharge_docs/d01_cellulitis.md',
    patient: P.ellis,
    mock_end_call_at: 'none',
    patient_turns: ['who is calling?', 'no, that is not my birthday', 'you have the wrong person', 'please stop calling this number'],
    expected: {
      extractions: { identity_verified: false },
      escalations: ['identity_failed'],
      required_steps_completed: ['greeting'],
      outcome: 'escalated',
    },
    notes: 'max_attempts 2 -> warm_transfer_to_staff',
  },
  {
    id: 's08_identity_no_answer',
    title: 'Identity failure: refuses to confirm',
    discharge_doc: 'discharge_docs/d05_diabetes.md',
    patient: P.osei,
    mock_end_call_at: 'none',
    patient_turns: ['why do you need my birthday?', 'I am not telling you anything', 'no'],
    expected: {
      extractions: { identity_verified: false },
      escalations: ['identity_failed'],
      required_steps_completed: ['greeting'],
      outcome: 'escalated',
    },
    notes: 'identity failure never produces partial',
  },
  {
    id: 's09_confused_questions',
    title: 'Confused patient asks questions',
    discharge_doc: 'discharge_docs/d03_copd.md',
    patient: P.raman,
    patient_turns: [
      'yes, who is this again?',
      'sorry, what did you ask? breathing is a bit worse, no chest pain',
      'can you repeat that?',
      'yes I use the inhaler and the steroid tablet',
      'will you send me a reminder?',
    ],
    expected: { extractions: { ...CLEAN, shortness_of_breath: 'mild' }, escalations: [], required_steps_completed: ALL, outcome: 'completed' },
    notes: 'agent must rephrase without skipping steps',
  },
  {
    id: 's10_confused_repeats',
    title: 'Confused patient repeats himself',
    discharge_doc: 'discharge_docs/d04_postop.md',
    patient: P.novak,
    patient_turns: [
      'yes it is me, hello?',
      'the tummy hurts, I said it hurts',
      'a seven out of ten',
      'I think I took the pills, maybe twice',
      'ok thank you',
    ],
    expected: { extractions: { ...CLEAN, pain_score: 7, wound_concern: false }, escalations: [], required_steps_completed: ALL, outcome: 'completed' },
    notes: 'last stated severity wins',
  },
  {
    id: 's11_refusal_early',
    title: 'Refusal at symptom check',
    discharge_doc: 'discharge_docs/d01_cellulitis.md',
    patient: P.ellis,
    mock_end_call_at: 'symptom_check',
    patient_turns: ['yes that is me', 'I do not want to talk about this, please hang up'],
    expected: {
      extractions: { identity_verified: true },
      escalations: [],
      required_steps_completed: ['greeting', 'identity_verification'],
      outcome: 'refused',
    },
    notes: 'agent closes politely, no re-asking loop',
  },
  {
    id: 's12_refusal_late',
    title: 'Refusal at medication review',
    discharge_doc: 'discharge_docs/d05_diabetes.md',
    patient: P.osei,
    mock_end_call_at: 'medication_review',
    patient_turns: ['yes, correct', 'no fever, no chest pain', 'I would rather not discuss my medicines', 'goodbye'],
    expected: {
      extractions: { identity_verified: true, chest_pain: false, shortness_of_breath: 'none' },
      escalations: [],
      required_steps_completed: ['greeting', 'identity_verification'],
      outcome: 'refused',
    },
    notes: 'symptom info recorded before the refusal',
  },
  {
    id: 's13_silence',
    title: 'Unresponsive patient',
    discharge_doc: 'discharge_docs/d03_copd.md',
    patient: P.raman,
    mock_end_call_at: 'none',
    patient_turns: ['yes, that is me', '', '', ''],
    expected: {
      extractions: { identity_verified: true },
      escalations: [],
      required_steps_completed: ['greeting', 'identity_verification'],
      outcome: 'partial',
    },
    notes: 'turn budget exhausts; the call never loops forever',
  },
  {
    id: 's14_med_not_in_doc',
    title: 'Patient reports a medicine not on the list',
    discharge_doc: 'discharge_docs/d02_cardiac.md',
    patient: P.whitfield,
    patient_turns: [
      'yes, it is me',
      'no chest pain, breathing okay',
      'no fever',
      'I took my neighbours water pill as well',
      'clinic next week',
    ],
    expected: {
      extractions: { ...CLEAN, medication_adherent: false, medication_issues: ['took a neighbours water pill that was not prescribed'] },
      escalations: [],
      required_steps_completed: ALL,
      outcome: 'completed',
    },
    notes: 'agent records, never advises',
  },
  {
    id: 's15_ambiguous_severity',
    title: 'Ambiguous severity language',
    discharge_doc: 'discharge_docs/d04_postop.md',
    patient: P.novak,
    patient_turns: [
      'yes speaking',
      'the wound is angry looking, pretty bad honestly',
      'I would say an eight out of ten',
      'yes taking them',
      'alright, thanks',
    ],
    expected: { extractions: { ...CLEAN, pain_score: 8, wound_concern: true }, escalations: [], required_steps_completed: ALL, outcome: 'completed' },
    notes: 'ambiguous wording maps onto canonical severity',
  },
];

mkdirSync(OUT, { recursive: true });
for (const scenario of scenarios) {
  const document = {
    id: scenario.id,
    title: scenario.title,
    ...(scenario.mock_end_call_at ? { mock_end_call_at: scenario.mock_end_call_at } : {}),
    discharge_doc: scenario.discharge_doc,
    patient: scenario.patient,
    patient_turns: scenario.patient_turns,
    expected: scenario.expected,
    notes: scenario.notes,
  };
  const header = '# SYNTHETIC scenario — fictional patient data only, never real PHI.\n';
  writeFileSync(new URL(`${scenario.id}.yaml`, OUT), header + YAML.stringify(document), 'utf8');
}
console.log(`wrote ${scenarios.length} scenarios to ${OUT.pathname}`);
