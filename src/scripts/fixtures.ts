/**
 * SYNTHETIC PATIENT FIXTURES — invented people. Nothing here is real PHI, and the
 * project never accepts real PHI by design.
 */
export interface SyntheticPatient {
  externalRef: string;
  firstName: string;
  lastName: string;
  dob: string;
  phone: string;
  /** Path relative to the repo root. */
  dischargeDoc: string;
}

export const SYNTHETIC_PATIENTS: SyntheticPatient[] = [
  {
    externalRef: 'SYN-0001',
    firstName: 'Jordan',
    lastName: 'Ellis',
    dob: '1968-04-12',
    phone: '+15550001001',
    dischargeDoc: 'evals/discharge_docs/d01_cellulitis.md',
  },
  {
    externalRef: 'SYN-0002',
    firstName: 'Marcus',
    lastName: 'Whitfield',
    dob: '1955-09-30',
    phone: '+15550001002',
    dischargeDoc: 'evals/discharge_docs/d02_cardiac.md',
  },
  {
    externalRef: 'SYN-0003',
    firstName: 'Priya',
    lastName: 'Raman',
    dob: '1960-01-22',
    phone: '+15550001003',
    dischargeDoc: 'evals/discharge_docs/d03_copd.md',
  },
  {
    externalRef: 'SYN-0004',
    firstName: 'Elena',
    lastName: 'Novak',
    dob: '1982-06-05',
    phone: '+15550001004',
    dischargeDoc: 'evals/discharge_docs/d04_postop.md',
  },
  {
    externalRef: 'SYN-0005',
    firstName: 'Samuel',
    lastName: 'Osei',
    dob: '1975-11-17',
    phone: '+15550001005',
    dischargeDoc: 'evals/discharge_docs/d05_diabetes.md',
  },
];
