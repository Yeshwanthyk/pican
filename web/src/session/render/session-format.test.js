import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  formatToolCall,
  getTreeNodeDisplayHtml,
  shortenPath,
  truncate,
} from './session-format.js';
import { extractContent } from '../tree/session-filter.js';

describe('session format helpers', () => {
  it('shortens home paths and formats common tool calls', () => {
    expect(shortenPath('/Users/alice/project/file')).toBe('~/project/file');
    expect(shortenPath('/home/bob/project')).toBe('~/project');
    expect(formatToolCall('read', { path: '/Users/a/x', offset: 3, limit: 2 })).toBe(
      '[read: ~/x:3-4]',
    );
    expect(formatToolCall('bash', { command: 'echo hello\nworld' })).toBe(
      '[bash: echo hello world]',
    );
  });

  it('escapes and truncates strings', () => {
    expect(escapeHtml('<x>')).toBe('&lt;x&gt;');
    expect(truncate('abcdef', 3)).toBe('abc...');
  });

  it('formats extension tool calls as compact summaries', () => {
    expect(formatToolCall('TaskCreate', { subject: 'Ship renderer' })).toBe(
      '[TaskCreate: Ship renderer]',
    );
    expect(formatToolCall('TaskGet', { task_id: '42' })).toBe('[TaskGet: 42]');
    expect(formatToolCall('TaskExecute', { task_ids: ['1', '2'] })).toBe('[TaskExecute: 1, 2]');
    expect(formatToolCall('subagent_spawn', { title: 'Review UI' })).toBe(
      '[subagent_spawn: Review UI]',
    );
    expect(formatToolCall('subagent_check', { id: 'agent-1' })).toBe('[subagent_check: agent-1]');
    expect(formatToolCall('workflow', { name: 'Release', status: 'running' })).toBe(
      '[workflow: Release (running)]',
    );
  });

  it('renders tree display html for messages and tool results', () => {
    const toolCallMap = new Map([['tc1', { name: 'ls', arguments: { path: '/tmp' } }]]);
    expect(
      getTreeNodeDisplayHtml({ type: 'message', message: { role: 'user', content: 'hi' } }, 'L', {
        extractContent,
      }),
    ).toContain('[L]');
    expect(
      getTreeNodeDisplayHtml(
        {
          type: 'message',
          message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
        },
        undefined,
        { extractContent },
      ),
    ).toContain('assistant:');
    expect(
      getTreeNodeDisplayHtml(
        { type: 'message', message: { role: 'toolResult', toolCallId: 'tc1' } },
        undefined,
        { extractContent, toolCallMap },
      ),
    ).toContain('[ls: /tmp]');
  });
});
