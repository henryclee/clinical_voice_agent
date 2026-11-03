PATH = 'tests/unit/parseToolCalls.test.ts'
lines = open(PATH).read().split('\n')
for n, line in enumerate(lines, 1):
    if 'tool_call' in line or 'IM_START' in line or 'IM_END' in line or 'marker' in line:
        print(n, repr(line))
