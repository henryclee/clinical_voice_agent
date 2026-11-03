PATH = 'tests/unit/parseToolCalls.test.ts'
src = open(PATH).read()

OPEN = chr(60) + '|tool_call|' + chr(62)
CLOSE = chr(60) + '|/tool_call|' + chr(62)

before = src.count(OPEN) + src.count(CLOSE)
src = src.replace(OPEN + '{', 'CALL_OPEN + \'{')
src = src.replace(CLOSE + '`', '\' + CALL_CLOSE}')
src = src.replace(CLOSE + '\'', '\' + CALL_CLOSE')
src = src.replace("it('parses an inline " + OPEN + " block'", "it('parses an inline pseudo-call block'")

open(PATH, 'w').write(src)
print('markers before:', before, 'after:', src.count(OPEN) + src.count(CLOSE))
