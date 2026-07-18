import { describe, expect, it, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import ToolCall from './ToolCall.svelte';

afterEach(cleanup);

function model({ entries = [], renderedTools = null } = {}) {
  return { entries, renderedTools };
}

describe('ToolCall', () => {
  it('renders a collapsed native disclosure with a compact status summary', () => {
    const call = { id: 'b', name: 'bash', arguments: { command: 'echo hello\nworld' } };
    const { container } = render(ToolCall, { props: { call, model: model() } });
    const fold = container.querySelector('.tool-fold');

    expect(fold?.tagName).toBe('DETAILS');
    expect(fold?.open).toBe(false);
    expect(container.querySelector('.tool-fold-summary')?.textContent).toContain(
      'bash echo hello world',
    );
    expect(container.querySelector('.tool-fold-status')?.classList).toContain('pending');
  });

  it('opens failed tool calls and keeps the result anchor on the outer wrapper', () => {
    const call = { id: 'b', name: 'bash', arguments: { command: 'false' } };
    const result = {
      id: 'result-1',
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'b',
        isError: true,
        content: [{ type: 'text', text: 'failed' }],
      },
    };
    const { container } = render(ToolCall, {
      props: { call, model: model({ entries: [result] }) },
    });

    expect(container.querySelector('.tool-fold')?.open).toBe(true);
    expect(container.querySelector('.tool-fold-summary')?.textContent).toContain('error');
    expect(container.querySelector('.tool-execution')?.id).toBe('entry-result-1');
    expect(container.querySelector('.tool-fold')?.id).toBe('');
  });

  it('renders a custom tool as escaped JSON when no pre-rendered HTML exists', () => {
    const call = { id: 'call-1', name: 'custom_tool', arguments: { value: '<x>' } };
    const { container } = render(ToolCall, { props: { call, model: model() } });
    expect(container.querySelector('.tool-name')?.textContent).toBe('custom_tool');
    // textContent decodes entities, so the raw chars appear (proving they were escaped in HTML).
    expect(container.querySelector('pre')?.textContent).toContain('"value": "<x>"');
  });

  it('renders pre-rendered custom-tool HTML', () => {
    const call = { id: 'call-1', name: 'custom_tool', arguments: {} };
    const { container } = render(ToolCall, {
      props: {
        call,
        model: model({ renderedTools: { 'call-1': { callHtml: '<span>custom rendered</span>' } } }),
      },
    });
    expect(container.textContent).toContain('custom rendered');
  });

  it('renders a bash command', () => {
    const call = { id: 'b', name: 'bash', arguments: { command: 'ls -la' } };
    const { container } = render(ToolCall, { props: { call, model: model() } });
    expect(container.querySelector('.tool-command')?.textContent).toContain('ls -la');
  });

  it('renders an ask_user_question card with clickable options', () => {
    const call = {
      id: 'q',
      name: 'ask_user_question',
      arguments: {
        questions: [{ question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] }],
      },
    };
    const { container } = render(ToolCall, { props: { call, model: model() } });
    expect(container.querySelector('.ask-question-card')).not.toBeNull();
    const opts = container.querySelectorAll('.ask-question-option-action');
    expect(opts.length).toBe(2);
    expect(opts[0].dataset.answer).toBe('A');
  });

  it('marks multi-select questions as needing submit', () => {
    const call = {
      id: 'q',
      name: 'pi_web_ask_user_question',
      arguments: {
        questions: [{ question: 'Pick many', multiSelect: true, options: [{ label: 'A' }] }],
      },
    };
    const { container } = render(ToolCall, { props: { call, model: model() } });
    expect(container.querySelector('.ask-question-card')?.dataset.needsSubmit).toBe('true');
    expect(container.querySelector('.ask-question-block')?.dataset.multiSelect).toBe('true');
  });

  it('renders task tools as parsed task rows with passthrough output', () => {
    const call = {
      id: 'task-call',
      name: 'TaskCreate',
      arguments: { subject: 'Build task cards' },
    };
    const result = {
      id: 'task-result',
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'task-call',
        content: [{ type: 'text', text: 'Created:\n#12 [pending] Build task cards' }],
      },
    };
    const { container } = render(ToolCall, {
      props: { call, model: model({ entries: [result] }) },
    });

    expect(container.querySelector('.task-tool-card')).not.toBeNull();
    expect(container.querySelector('.extension-tool-focus')?.textContent).toBe('Build task cards');
    expect(container.querySelector('.task-tool-row')?.textContent).toContain('#12');
    expect(container.querySelector('.status-pending')?.textContent).toBe('pending');
    expect(container.querySelector('.extension-tool-plain')?.textContent).toBe('Created:');
    expect(container.querySelector('.tool-fold-summary')?.textContent).toContain(
      'TaskCreate Build task cards',
    );
  });

  it('renders structured subagent rows and keeps wait output collapsed', () => {
    const call = { id: 'sub-call', name: 'subagent_wait', arguments: {} };
    const result = {
      id: 'sub-result',
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'sub-call',
        content: [{ type: 'text', text: '## agent-1\nFinished the review.' }],
        details: {
          results: [{ id: 'agent-1', title: 'Review', status: 'done' }],
          pending: ['agent-2'],
        },
      },
    };
    const { container } = render(ToolCall, {
      props: { call, model: model({ entries: [result] }) },
    });

    expect(container.querySelectorAll('.subagent-row')).toHaveLength(2);
    expect(container.querySelector('.status-done')?.textContent.trim()).toBe('done');
    expect(container.querySelector('.status-running')?.textContent.trim()).toBe('running');
    expect(container.querySelector('.extension-output-details')?.open).toBe(false);
    expect(container.querySelector('.extension-markdown')?.textContent).toContain(
      'Finished the review.',
    );
  });

  it('falls back to plain subagent output when details are missing', () => {
    const call = { id: 'sub-call', name: 'subagent_check', arguments: { id: 'agent-1' } };
    const result = {
      id: 'sub-result',
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'sub-call',
        content: [{ type: 'text', text: 'No structured details' }],
      },
    };
    const { container } = render(ToolCall, {
      props: { call, model: model({ entries: [result] }) },
    });

    expect(container.querySelector('.subagent-tool-card')?.textContent).toContain(
      'No structured details',
    );
  });

  it('renders workflow phases, agents, and a collapsed result', () => {
    const call = { id: 'workflow-call', name: 'workflow', arguments: {} };
    const result = {
      id: 'workflow-result',
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'workflow-call',
        content: [],
        details: {
          runId: 'run-1',
          name: 'Release',
          status: 'running',
          currentPhase: 1,
          phases: [{ title: 'Build' }, { title: 'Test' }, { title: 'Ship' }],
          agents: [{ label: 'Reviewer', phase: 'Test', status: 'running', model: 'codex' }],
          result: '**Partial** result',
        },
      },
    };
    const { container } = render(ToolCall, {
      props: { call, model: model({ entries: [result] }) },
    });

    expect(container.querySelector('.workflow-name')?.textContent).toBe('Release');
    expect(container.querySelectorAll('.workflow-phase')).toHaveLength(3);
    expect(container.querySelector('.phase-done')?.textContent).toContain('Build');
    expect(container.querySelector('.phase-current')?.textContent).toContain('Test');
    expect(container.querySelector('.workflow-agent-row')?.textContent).toContain('Reviewer');
    expect(container.querySelector('.extension-output-details')?.open).toBe(false);
  });
});
