/**
 * Tool-call tolerance layer. The orchestrator must never depend on a model emitting
 * well-formed tool calls, so every shape a local model is known to produce has to
 * degrade into either a usable ToolCall or a counted rejection — never an exception.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  parseToolCallResponse,
  stripReasoning,
  tolerantJsonParse,
} from '../../src/llm/parseToolCalls.js';
import { resetToolCallStats, toolCallStats, toolCallValidityRate } from '../../src/llm/stats.js';
import { TOOL_NAMES } from '../../src/tools/definitions.js';

const SYMPTOM_ARGS = { symptom: 'pain', severity: 3, onset: '2 days ago' };

// Chat-template / pseudo-call markers assembled from char codes.
const marker = (word: string): string =>
  String.fromCharCode(60, 124) + word + String.fromCharCode(124, 62);
//const IM_START = marker('im_' + 'start');
//const IM_END = marker('im_' + 'end');
const CALL_OPEN = '<tool_call>';
const CALL_CLOSE = '</tool_call>';


beforeEach(() => {
  resetToolCallStats();
});

describe('tier 1: native tool_calls', () => {
  it('passes through a provider-shaped call with stringified arguments', () => {
    const result = parseToolCallResponse({
      native: [
        { id: 'call_1', type: 'function', function: { name: 'record_symptom', arguments: JSON.stringify(SYMPTOM_ARGS) } },
      ],
      knownToolNames: TOOL_NAMES,
    });
    expect(result.tier).toBe('native');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({ id: 'call_1', name: 'record_symptom', arguments: SYMPTOM_ARGS });
    expect(result.rejected).toEqual([]);
  });

  it('accepts native arguments already given as an object', () => {
    const result = parseToolCallResponse({
      native: [{ id: 'call_2', name: 'record_vital', arguments: { name: 'temperature_f', value: 101.5 } }],
      knownToolNames: TOOL_NAMES,
    });
    expect(result.tier).toBe('native');
    expect(result.toolCalls[0]?.arguments).toEqual({ name: 'temperature_f', value: 101.5 });
  });

  it('synthesizes an id when the provider omits one', () => {
    const result = parseToolCallResponse({ native: [{ name: 'end_call', arguments: { outcome: 'completed' } }] });
    expect(result.toolCalls[0]?.id).toMatch(/^call_native_/);
  });

  it('unwraps a {tool_calls: [...]} wrapper in a fenced block', () => {
    const result = parseToolCallResponse({
      text: '```json\n{"tool_calls": [{"name": "record_symptom", "arguments": ' + JSON.stringify(SYMPTOM_ARGS) + '}]}\n```',
    });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.name).toBe('record_symptom');
  });
});

describe('tier 2-4: text fallbacks', () => {
  it('parses an inline <tool_call> block', () => {
    const result = parseToolCallResponse({
      text: `Sure.<tool_call>{"name": "record_symptom", "arguments": ${JSON.stringify(SYMPTOM_ARGS)}}</tool_call>`,
      knownToolNames: TOOL_NAMES,
    });
    expect(result.tier).toBe('inline_tag');
    expect(result.toolCalls[0]?.name).toBe('record_symptom');
  });

  it('parses a fenced ```json block with python literals', () => {
    const result = parseToolCallResponse({
      text: 'Recording now:\n```json\n{"name": "record_symptom", "arguments": {"symptom": "pain", "severity": 3, "onset": "2 days ago", "presence": True, }}\n```',
      knownToolNames: TOOL_NAMES,
    });
    expect(result.tier).toBe('fenced_json');
    expect(result.toolCalls[0]?.arguments).toMatchObject({ presence: true, severity: 3 });
  });

  it('parses a bare JSON call embedded in prose', () => {
    const result = parseToolCallResponse({
      text: `I will note that. {"name": "record_symptom", "arguments": ${JSON.stringify(SYMPTOM_ARGS)}} Thank you.`,
      knownToolNames: TOOL_NAMES,
    });
    expect(result.tier).toBe('bare_json');
    expect(result.toolCalls[0]?.arguments).toEqual(SYMPTOM_ARGS);
  });

  it('ignores prose JSON that carries no tool name', () => {
    const result = parseToolCallResponse({ text: 'Your numbers {"pain": 3, "fever": 101} look fine.' });
    expect(result.toolCalls).toEqual([]);
    expect(result.tier).toBe('none');
  });

  it('returns none for plain speech', () => {
    expect(parseToolCallResponse({ text: 'How are you feeling today?' }).tier).toBe('none');
    expect(parseToolCallResponse({}).tier).toBe('none');
  });

});

describe('name normalization and rejection', () => {
  it.each(['Record_Symptom', 'record-symptom', 'record symptom', 'RECORD_SYMPTOM', '  record_symptom '])(
    'normalizes %j to record_symptom',
    (raw) => {
      const result = parseToolCallResponse({ text: `{"name": "${raw}", "arguments": ${JSON.stringify(SYMPTOM_ARGS)}}` });
      expect(result.toolCalls[0]?.name).toBe('record_symptom');
    },
  );

  it('rejects unknown tool names against the whitelist and counts it', () => {
    const result = parseToolCallResponse({
      text: '{"name": "prescribe_medication", "arguments": {}}',
      knownToolNames: TOOL_NAMES,
    });
    expect(result.toolCalls).toEqual([]);
    expect(result.rejected.join(' ')).toMatch(/unknown tool "prescribe_medication"/);
    expect(toolCallStats().calls_rejected).toBe(1);
    expect(toolCallValidityRate()).toBe(0);
  });

  it('accepts any name when no whitelist is supplied', () => {
    const result = parseToolCallResponse({ text: '{"name": "whatever", "arguments": {}}' });
    expect(result.toolCalls[0]?.name).toBe('whatever');
  });

  it('rejects a call whose arguments string is not JSON', () => {
    const result = parseToolCallResponse({
      native: [{ id: 'x', function: { name: 'record_symptom', arguments: 'not json at all' } }],
      knownToolNames: TOOL_NAMES,
    });
    expect(result.toolCalls).toEqual([]);
    expect(result.rejected.join(' ')).toMatch(/not valid JSON/);
  });

  it('treats empty/null-ish argument strings as no arguments', () => {
    for (const raw of ['', '{}', '[]', 'null']) {
      const result = parseToolCallResponse({
        native: [{ id: `c_${raw}`, function: { name: 'end_call', arguments: raw } }],
        knownToolNames: TOOL_NAMES,
      });
      expect(result.toolCalls[0]?.arguments).toEqual({});
    }
  });

  it('keeps usable calls from a mixed batch', () => {
    const result = parseToolCallResponse({
      native: [
        { id: 'a', name: 'record_symptom', arguments: SYMPTOM_ARGS },
        { id: 'b', name: 'delete_all_records', arguments: {} },
      ],
      knownToolNames: TOOL_NAMES,
    });
    expect(result.toolCalls.map((call) => call.name)).toEqual(['record_symptom']);
    expect(result.rejected).toHaveLength(1);
    expect(toolCallValidityRate()).toBe(0.5);
  });
});

describe('tolerantJsonParse', () => {
  it('fixes python literals, trailing commas and single quotes', () => {
    const cases: [string, unknown][] = [
      ["{'symptom': 'pain', 'severity': 3}", { symptom: 'pain', severity: 3 }],
      ['{"a": null, "b": [1, 2,]}', { a: null, b: [1, 2] }],
      ['{"taken": True, "issues": None}', { taken: true, issues: null }],
      ['{"list": [True, False, None]}', { list: [true, false, null] }],
    ];
    for (const [raw, expected] of cases) {
      const parsed = tolerantJsonParse(raw);
      expect(parsed, raw).not.toBeNull();
      expect(parsed?.value).toEqual(expected);
      expect(parsed?.coerced).toBe(true);
    }
  });

  it('does not flag clean JSON as coerced', () => {
    const parsed = tolerantJsonParse('{"a": 1}');
    expect(parsed?.value).toEqual({ a: 1 });
    expect(parsed?.coerced).toBe(false);
  });

  it('returns null instead of throwing on garbage', () => {
    expect(tolerantJsonParse('###')).toBeNull();
    expect(tolerantJsonParse('{')).toBeNull();
  });
});

describe('stripReasoning', () => {
  // The impl strips its own reasoning markers (REASONING_BLOCKS + unclosed
  // fallback in parseToolCalls.ts), not the chat-template turn markers.
  const THINK_OPEN = marker('think');       // <|think|>
  const THINK_CLOSE = marker('/think');     // <|/think|>

  it('removes chat-template reasoning blocks before speech', () => {
    expect(
      stripReasoning(THINK_OPEN + 'I should ask about pain.' + THINK_CLOSE + 'How are you?'),
    ).toBe('How are you?');
    expect(stripReasoning('<thinking>hidden</thinking>Visible line')).toBe('Visible line');
    expect(stripReasoning('<reasoning>hidden</reasoning> Ok')).toBe('Ok');
  });

  it('drops everything after an unclosed reasoning block', () => {
    expect(stripReasoning(THINK_OPEN + 'well, let me think about this')).toBe('');
  });

  it('leaves normal sentences untouched and handles nullish input', () => {
    expect(stripReasoning('Please rest and drink fluids.')).toBe('Please rest and drink fluids.');
    expect(stripReasoning(undefined)).toBe('');
    expect(stripReasoning(null)).toBe('');
  });
});

describe('parse tier statistics', () => {
  it('reports per-tier counts for a run', () => {
    parseToolCallResponse({ native: [{ name: 'end_call', arguments: {} }] });
    parseToolCallResponse({ text: CALL_OPEN + '{"name": "end_call", "arguments": {}}' + CALL_CLOSE });
    parseToolCallResponse({ text: 'Your numbers look fine.' });

    const stats = toolCallStats();
    expect(stats.tiers.native).toBe(1);
    expect(stats.tiers.inline_tag).toBe(1);
    expect(stats.responses_parsed).toBe(2);
    expect(stats.calls_accepted).toBe(2);
    // Plain speech never mentions tool syntax, so it stays out of the failure
    // counter entirely (see the documented definition in src/llm/stats.ts).
    expect(stats.responses_failed).toBe(0);
  });

  it('counts broken tool syntax that yields nothing usable as a failure', () => {
    parseToolCallResponse({
      text: CALL_OPEN + '{"name": "end_call", "arguments": {"outcome": ' + CALL_CLOSE,
    });
    const stats = toolCallStats();
    expect(stats.responses_failed).toBe(1);
    expect(stats.tiers.inline_tag).toBe(0);
    expect(stats.calls_accepted).toBe(0);
  });

  it('validity rate is null when nothing was attempted', () => {
    expect(toolCallValidityRate()).toBeNull();
  });
});

