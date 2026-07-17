import { describe, expect, it } from 'vitest';
import {
  normalizeWorkflowSummary,
  workflowPhaseProgress,
  workflowTranscriptGroups,
} from './workflows.js';

describe('workflow helpers', () => {
  it('normalizes optional summary fields', () => {
    expect(normalizeWorkflowSummary({ runId: 'wf_123456abcdef', phaseCount: 3 })).toEqual({
      runId: 'wf_123456abcdef',
      name: '',
      description: '',
      status: '',
      startedAt: '',
      finishedAt: '',
      currentPhase: '',
      currentPhaseNumber: 0,
      phaseCount: 3,
      agentCount: 0,
      hasResult: false,
      hasTranscripts: false,
    });
  });

  it('derives phase progress from the current phase and terminal status', () => {
    const workflow = {
      status: 'running',
      currentPhase: 'Build',
      phases: [{ title: 'Plan' }, { title: 'Build' }, { title: 'Ship' }],
    };
    expect(workflowPhaseProgress(workflow)).toEqual({ current: 2, total: 3 });
    expect(workflowPhaseProgress({ ...workflow, status: 'completed' })).toEqual({
      current: 3,
      total: 3,
    });
  });

  it('orders transcript groups by numeric agent index', () => {
    const groups = workflowTranscriptGroups(
      { 10: [{ role: 'assistant', text: 'later' }], 2: [{ role: 'user', text: 'first' }] },
      [],
    );
    expect(groups.map((group) => group.index)).toEqual(['2', '10']);
  });
});
