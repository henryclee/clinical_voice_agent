"""One-shot repair for tests/unit/parseToolCalls.test.ts.

Marks the pseudo-call / chat-template markers are assembled from char codes so the
literal sequences stay out of every source file in the repo.
"""

PATH = 'tests/unit/parseToolCalls.test.ts'

lines = open(PATH).read().split('\n')


def find(pred, start=0):
    for i in range(start, len(lines)):
        if pred(lines[i]):
            return i
    raise SystemExit('FATAL: anchor not found')


# --- 1) char-code-built marker constants -----------------------------------------
i = find(lambda l: l.startswith('const IM_START'))
j = find(lambda l: l.lstrip().startswith('// const IM_END'), i)
lines[i:j + 1] = [
    '// Chat-template / pseudo-call markers assembled from char codes.',
    'const marker = (word: string): string =>',
    '  String.fromCharCode(60, 124) + word + String.fromCharCode(124, 62);',
    "const IM_START = marker('im_' + 'start');",
    "const IM_END = marker('im_' + 'end');",
    "const CALL_OPEN = marker('tool_' + 'call');",
    "const CALL_CLOSE = marker('/tool_' + 'call');",
]

# --- 2) un-nest the four appended describes --------------------------------------
i = find(lambda l: l.startswith("describe('name normalization"))
lines[i:i] = ['});', '']


def block(name):
    start = find(lambda l: l.startswith("describe('" + name))
    end = find(lambda l: l == '});', start)
    return start, end


# --- 3) stripReasoning fixtures need real closing markers -----------------------
s, e = block('stripReasoning')
lines[s:e + 1] = [
    "describe('stripReasoning', () => {",
    "  it('removes reasoning blocks before the speakable text', () => {",
    "    expect(stripReasoning(IM_START + 'think I should ask about pain.' + IM_END + 'How are you?')).toBe('How are you?');",
    "    expect(stripReasoning('<thinking>hidden</thinking>Visible line')).toBe('Visible line');",
    "    expect(stripReasoning('<reasoning>hidden</reasoning> Ok')).toBe('Ok');",
    "  });",
    "",
    "  it('drops everything after an unclosed reasoning block', () => {",
    "    expect(stripReasoning(IM_START + 'well, let me think about this')).toBe('');",
    "  });",
    "",
    "  it('leaves normal sentences untouched and handles nullish input', () => {",
    "    expect(stripReasoning('Please rest and drink fluids.')).toBe('Please rest and drink fluids.');",
    "    expect(stripReasoning(undefined)).toBe('');",
    "    expect(stripReasoning(null)).toBe('');",
    "  });",
    "});",
]

# --- 4) stats semantics: plain speech is not a failure -------------------------
s, e = block('parse tier statistics')
lines[s:e + 1] = [
    "describe('parse tier statistics', () => {",
    "  it('reports per-tier counts for a run', () => {",
    "    parseToolCallResponse({ native: [{ name: 'end_call', arguments: {} }] });",
    "    parseToolCallResponse({ text: CALL_OPEN + '{\"name\": \"end_call\", \"arguments\": {}}' + CALL_CLOSE });",
    "    parseToolCallResponse({ text: 'Your numbers look fine.' });",
    "",
    "    const stats = toolCallStats();",
    "    expect(stats.tiers.native).toBe(1);",
    "    expect(stats.tiers.inline_tag).toBe(1);",
    "    expect(stats.responses_parsed).toBe(2);",
    "    expect(stats.calls_accepted).toBe(2);",
    "    // Plain speech never mentions tool syntax, so it stays out of the failure",
    "    // counter entirely (see the documented definition in src/llm/stats.ts).",
    "    expect(stats.responses_failed).toBe(0);",
    "  });",
    "",
    "  it('counts broken tool syntax that yields nothing usable as a failure', () => {",
    "    parseToolCallResponse({",
    "      text: CALL_OPEN + '{\"name\": \"end_call\", \"arguments\": {\"outcome\": ' + CALL_CLOSE,",
    "    });",
    "    const stats = toolCallStats();",
    "    expect(stats.responses_failed).toBe(1);",
    "    expect(stats.tiers.inline_tag).toBe(0);",
    "    expect(stats.calls_accepted).toBe(0);",
    "  });",
    "",
    "  it('validity rate is null when nothing was attempted', () => {",
    "    expect(toolCallValidityRate()).toBeNull();",
    "  });",
    "});",
]

# --- 5) drop the stray closing brace left over from the earlier append ---------
while lines and lines[-1].strip() == '':
    lines.pop()
if lines[-1] == '});':
    lines.pop()

open(PATH, 'w').write('\n'.join(lines) + '\n')

src = '\n'.join(lines)
print('braces balanced:', src.count('{') == src.count('}'))
print('parens balanced:', src.count('(') == src.count(')'))
print('lines:', len(lines))
