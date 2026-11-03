import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { AppLogger } from '../common/logger.js';
import { noopLogger } from '../common/logger.js';
import { ExtractionError, LlmCallError } from '../llm/errors.js';
import type { LlmClient } from '../llm/types.js';
import { DischargeParseError, parseDischargeMarkdown, type DischargeExtract } from './dischargeParser.js';
import { DischargeExtract as DischargeSchema } from './dischargeParser.js';

/**
 * LLM-based discharge extraction with honest fallbacks:
 *
 *   real client  -> extractStructured(json_schema) -> (failure) deterministic md parser
 *   mock client  -> deterministic md parser (the mock never pretends to be a model)
 *   image input  -> vision request when the client supports it; typed error otherwise,
 *                   telling the operator which dependency is missing (tesseract/poppler).
 */

export interface ExtractDischargeOptions {
  llm: LlmClient;
  source?: string;
  logger?: AppLogger;
}

export interface DischargeExtractionResult {
  data: DischargeExtract;
  method: 'llm' | 'markdown-heuristic' | 'vision';
  notes: string[];
}

const SYSTEM = [
  'You extract structured clinical information from a hospital discharge summary.',
  'The document is SYNTHETIC training data, not a real patient record.',
  'Copy values verbatim from the document. Never invent a value.',
  'Use "" / [] / 0 when a field is genuinely absent.',
].join(' ');

export async function extractDischarge(
  text: string,
  options: ExtractDischargeOptions,
): Promise<DischargeExtractionResult> {
  const logger = options.logger ?? noopLogger;
  const source = options.source ?? '<text>';

  if (options.llm.kind === 'mock') {
    return { data: parseDischargeMarkdown(text, source), method: 'markdown-heuristic', notes: ['mock LLM: deterministic parser used'] };
  }

  try {
    const data = await options.llm.extractStructured<DischargeExtract>({
      schema: DischargeSchema,
      system: SYSTEM,
      user: `Discharge document:\n"""\n${text.slice(0, 12_000)}\n"""`,
    });
    return { data, method: 'llm', notes: [] };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn({ source, error: reason }, 'LLM discharge extraction failed; falling back to markdown parser');
    try {
      return {
        data: parseDischargeMarkdown(text, source),
        method: 'markdown-heuristic',
        notes: [`llm extraction failed: ${reason}`],
      };
    } catch (parseError) {
      if (parseError instanceof DischargeParseError) {
        throw new DischargeParseError(source, [...parseError.issues, `llm extraction failed: ${reason}`]);
      }
      throw parseError;
    }
  }
}

/**
 * Vision path for photographed discharge papers. Requires a multimodal endpoint; when the
 * client cannot do vision, the caller gets a typed error naming what is missing.
 */
export async function extractDischargeFromImage(
  imagePath: string,
  options: ExtractDischargeOptions,
): Promise<DischargeExtractionResult> {
  const source = path.basename(imagePath);
  const absolute = path.resolve(imagePath);
  if (!existsSync(absolute)) throw new DischargeParseError(source, ['image file not found']);

  if (typeof options.llm.extractStructuredWithImage !== 'function') {
    throw new DischargeParseError(source, [
      'no vision-capable LLM configured; install tesseract + poppler for local OCR or point LLM_BASE_URL at a multimodal model',
    ]);
  }

  const dataUrl = `data:image/${path.extname(absolute).slice(1) || 'jpeg'};base64,${readFileSync(absolute).toString('base64')}`;
  try {
    const data = await options.llm.extractStructuredWithImage<DischargeExtract>({
      schema: DischargeSchema,
      system: SYSTEM,
      user: 'Extract the discharge summary fields from this photographed document.',
      dataUrl,
    });
    return { data, method: 'vision', notes: [] };
  } catch (error) {
    const reason =
      error instanceof ExtractionError || error instanceof LlmCallError ? error.message : String(error);
    throw new DischargeParseError(source, [`vision extraction failed: ${reason}`]);
  }
}
