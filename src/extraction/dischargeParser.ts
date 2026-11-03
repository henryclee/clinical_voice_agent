import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * Discharge document ingestion — text/markdown only.
 *
 * TODO(production): PDF support. Per the build plan, PDF parsing is out of v1 scope and
 * every fixture here is `.md`. A production build adds a PDF text layer (pdfjs) plus an
 * OCR path for scanned pages (tesseract CLI or transformers.js) — `parseDischargeFile`
 * currently returns a typed error for `.pdf`.
 */

export const Medication = z.object({
  name: z.string().min(1),
  dose: z.string().default(''),
  frequency: z.string().default(''),
});

export const FollowUp = z.object({
  provider: z.string().default(''),
  within_days: z.number().int().min(0).max(365).optional(),
  reason: z.string().default(''),
});

/** Canonical extraction target for a discharge document (PLAN Module C). */
export const DischargeExtract = z.object({
  patient_name: z.string().default(''),
  discharge_date: z.string().default(''),
  primary_diagnosis: z.string().default('unspecified'),
  medications: z.array(Medication).default([]),
  follow_up: FollowUp.default({ provider: '', reason: '' }),
  red_flags: z.array(z.string()).default([]),
  procedures: z.array(z.string()).default([]),
});
export type DischargeExtract = z.output<typeof DischargeExtract>;

/** Typed failure: an unreadable document is an error value, never a crash. */
export class DischargeParseError extends Error {
  readonly source: string;
  readonly issues: string[];
  constructor(source: string, issues: string[]) {
    super(`Could not parse discharge document (${source}): ${issues.join('; ')}`);
    this.name = 'DischargeParseError';
    this.source = source;
    this.issues = issues;
  }
}

type SectionKey = keyof DischargeExtract | 'patient';

const SECTION_ALIASES: Record<SectionKey, string[]> = {
  patient: ['patient', 'patient name'],
  patient_name: ['patient', 'patient name'],
  discharge_date: ['discharge date', 'date of discharge', 'discharge_date'],
  primary_diagnosis: ['diagnosis', 'primary diagnosis', 'discharge diagnosis'],
  procedures: ['procedures', 'procedure'],
  medications: ['medications', 'meds', 'discharge medications', 'prescriptions'],
  follow_up: ['follow-up', 'follow up', 'followup', 'follow-up appointment'],
  red_flags: ['red flags', 'warning signs', 'when to seek care'],
};

const HEADER = /^(#{1,6})\s*(.+?)\s*$/;
const KEY_VALUE = /^([A-Za-z][A-Za-z /_-]{1,40}):\s*(.*)$/;
const BULLET = /^[-*]\s+(.*)$/;
/** "Amoxicillin 500 mg twice daily" / "Metoprolol — 25 mg BID" */
const MED_LINE =
  /^(.+?)[\s—-]+(\d+(?:\.\d+)?\s*(?:mg|mcg|g|units?)(?:\/\w+)?(?:\s+[\w/.-]+){0,8}|once daily|twice daily|three times daily|four times daily|nightly|daily|BID|TID|QID|PRN|as needed)$/i;

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function matchSection(key: string): SectionKey | null {
  for (const [section, aliases] of Object.entries(SECTION_ALIASES)) {
    if (aliases.includes(key)) return section as SectionKey;
  }
  return null;
}

function parseMedicationLine(line: string): z.output<typeof Medication> | null {
  const trimmed = line.trim();
  const match = MED_LINE.exec(trimmed);
  if (match?.[1] && match[2]) {
    return { name: match[1].trim(), dose: match[2].trim(), frequency: '' };
  }
  return trimmed.length > 1 ? { name: trimmed, dose: '', frequency: '' } : null;
}

function splitList(value: string): string[] {
  return value
    .split(/[;,\n]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Deterministic markdown/plain-text parser for the synthetic fixtures. Deliberately
 * conservative: anything it cannot read becomes a typed `DischargeParseError` rather than
 * a silently empty extraction.
 */
export function parseDischargeMarkdown(text: string, source = '<text>'): DischargeExtract {
  const sections = new Map<string, string[]>();
  let current: string | null = null;

  const push = (section: string, value: string): void => {
    if (value.trim().length === 0) return;
    const list = sections.get(section) ?? [];
    list.push(value.trim());
    sections.set(section, list);
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const header = HEADER.exec(line);
    if (header?.[2]) {
      current = matchSection(normalizeKey(header[2]));
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet?.[1]) {
      if (current) push(current, bullet[1]);
      continue;
    }
    const keyValue = KEY_VALUE.exec(line);
    if (keyValue?.[1]) {
      const section = matchSection(normalizeKey(keyValue[1]));
      if (section) {
        current = section;
        push(section, keyValue[2] ?? '');
        continue;
      }
    }
    if (current) push(current, line);
  }

  const issues: string[] = [];
  const patientName = (sections.get('patient')?.[0] ?? sections.get('patient_name')?.[0] ?? '').trim();
  const dischargeDate = (sections.get('discharge_date')?.[0] ?? '').trim();
  const diagnosis = (sections.get('primary_diagnosis')?.[0] ?? '').trim();
  const medicationLines = sections.get('medications') ?? [];
  const followUpLines = sections.get('follow_up') ?? [];
  const redFlagLines = sections.get('red_flags') ?? [];
  const procedures = sections.get('procedures') ?? [];

  if (diagnosis.length === 0) issues.push('no diagnosis found');
  if (medicationLines.length === 0) issues.push('no medications found');
  if (issues.length > 0) throw new DischargeParseError(source, issues);

  const medications = medicationLines
    .flatMap((line) => splitList(line))
    .map((line) => parseMedicationLine(line))
    .filter((med): med is z.output<typeof Medication> => med !== null && med.name.length > 0);

  const followUpText = followUpLines.join(' ');
  const withinDays = /(\d+)\s*(?:day|days|d)\b/i.exec(followUpText);
  const provider = /(clinic|cardiology|primary care|surgery|heart failure|dr\.?\s*[A-Za-z'-]+)/i.exec(followUpText);

  const parsed = DischargeExtract.safeParse({
    patient_name: patientName,
    discharge_date: dischargeDate,
    primary_diagnosis: diagnosis,
    medications,
    follow_up: {
      provider: provider?.[1] ?? '',
      within_days: withinDays?.[1] ? Number.parseInt(withinDays[1], 10) : undefined,
      reason: followUpText,
    },
    red_flags: redFlagLines.flatMap((line) => splitList(line)),
    procedures,
  });

  if (!parsed.success) {
    throw new DischargeParseError(
      source,
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }
  return parsed.data;
}

/** Read a discharge file from disk. `.md`/`.txt` supported; `.pdf` returns a typed error. */
export function parseDischargeFile(filePath: string): DischargeExtract {
  const absolute = path.resolve(filePath);
  if (!existsSync(absolute)) throw new DischargeParseError(absolute, ['file not found']);
  const extension = path.extname(absolute).toLowerCase();
  if (extension === '.pdf') {
    throw new DischargeParseError(absolute, [
      'PDF ingestion is out of v1 scope — convert to markdown/text first (see README "Production gaps")',
    ]);
  }
  return parseDischargeMarkdown(readFileSync(absolute, 'utf8'), path.basename(absolute));
}

