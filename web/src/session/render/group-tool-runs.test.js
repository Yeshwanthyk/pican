import { describe, expect, it } from 'vitest';
import { formatToolRunBreakdown, groupToolRuns } from './group-tool-runs.js';

const user = (id) => ({
  id,
  type: 'message',
  message: { role: 'user', content: 'Keep going' },
});
const assistantText = (id, text = 'Done') => ({
  id,
  type: 'message',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const assistantTools = (id, names, { thinking = false } = {}) => ({
  id,
  type: 'message',
  message: {
    role: 'assistant',
    content: [
      ...(thinking ? [{ type: 'thinking', thinking: 'Working' }] : []),
      ...names.map((name, index) => ({ type: 'toolCall', id: `${id}-${index}`, name })),
    ],
  },
});
const toolResult = (id) => ({
  id,
  type: 'message',
  message: { role: 'toolResult', toolCallId: `call-${id}`, content: [] },
});
const bashExecution = (id) => ({
  id,
  type: 'message',
  message: { role: 'bashExecution', command: 'pwd', output: '', exitCode: 0 },
});
const subagentResult = (id) => ({
  id,
  type: 'custom_message',
  customType: 'subagent-result',
  content: 'Done',
});

describe('groupToolRuns', () => {
  it('collapses a run with more than four tool calls and builds a ranked breakdown', () => {
    const entries = [
      assistantTools('a1', ['bash', 'read', 'bash']),
      toolResult('r1'),
      bashExecution('b1'),
      subagentResult('s1'),
      assistantTools('a2', ['edit', 'bash', 'read']),
    ];

    const [group] = groupToolRuns(entries);
    expect(group).toMatchObject({
      kind: 'group',
      entries,
      toolCount: 6,
      breakdown: {
        tools: [
          { name: 'bash', count: 3 },
          { name: 'read', count: 2 },
          { name: 'edit', count: 1 },
        ],
        remaining: 0,
      },
    });
    expect(formatToolRunBreakdown(group.breakdown)).toBe('bash x3, read x2, edit x1');
  });

  it('does not merge tool runs across assistant prose', () => {
    const first = assistantTools('a1', ['bash', 'bash', 'read']);
    const prose = assistantText('a2');
    const second = assistantTools('a3', ['edit', 'edit', 'read']);

    expect(groupToolRuns([first, prose, second])).toEqual([
      { kind: 'entry', entry: first },
      { kind: 'entry', entry: prose },
      { kind: 'entry', entry: second },
    ]);
  });

  it('keeps runs of four tool calls inline', () => {
    const entries = [assistantTools('a1', ['bash', 'read']), assistantTools('a2', ['edit', 'ls'])];
    expect(groupToolRuns(entries)).toEqual(entries.map((entry) => ({ kind: 'entry', entry })));
  });

  it('always breaks runs at user messages', () => {
    const first = assistantTools('a1', ['bash', 'bash', 'bash']);
    const prompt = user('u1');
    const second = assistantTools('a2', ['read', 'read', 'read']);

    expect(groupToolRuns([first, prompt, second])).toEqual([
      { kind: 'entry', entry: first },
      { kind: 'entry', entry: prompt },
      { kind: 'entry', entry: second },
    ]);
  });

  it('groups mixed tool and thinking-only assistant messages', () => {
    const entries = [
      assistantTools('a1', ['bash', 'read'], { thinking: true }),
      assistantTools('thinking', [], { thinking: true }),
      assistantTools('a2', ['edit', 'write', 'ls']),
    ];

    expect(groupToolRuns(entries)).toMatchObject([{ kind: 'group', entries, toolCount: 5 }]);
  });

  it('groups leading and trailing runs independently', () => {
    const leading = [
      toolResult('r0'),
      assistantTools('a1', ['bash', 'bash', 'bash', 'bash', 'bash']),
    ];
    const prose = assistantText('a2');
    const trailing = [
      assistantTools('a3', ['read', 'read', 'read']),
      toolResult('r1'),
      assistantTools('a4', ['edit', 'edit']),
    ];

    expect(groupToolRuns([...leading, prose, ...trailing])).toMatchObject([
      { kind: 'group', entries: leading, toolCount: 5 },
      { kind: 'entry', entry: prose },
      { kind: 'group', entries: trailing, toolCount: 5 },
    ]);
  });

  it('limits the breakdown to four tool names', () => {
    const [group] = groupToolRuns([assistantTools('a1', ['bash', 'read', 'edit', 'write', 'ls'])]);
    expect(group.breakdown.remaining).toBe(1);
    expect(formatToolRunBreakdown(group.breakdown, '+1 more')).toBe(
      'bash x1, read x1, edit x1, write x1, +1 more',
    );
  });
});
