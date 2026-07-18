import { getJSON } from '../shared/api.js';

const statuses = new Set(['running', 'done', 'error', 'unknown']);

function stringValue(value) {
  return typeof value === 'string' ? value : '';
}

export function normalizeSubagent(subagent = {}) {
  const status = stringValue(subagent.status);
  return {
    id: stringValue(subagent.id),
    title: stringValue(subagent.title),
    harness: stringValue(subagent.harness),
    status: statuses.has(status) ? status : 'unknown',
    spawnedAt: stringValue(subagent.spawnedAt),
    parentSession: stringValue(subagent.parentSession),
    parentProject: stringValue(subagent.parentProject),
    childSession: stringValue(subagent.childSession),
    childProject: stringValue(subagent.childProject),
    lastActivity: stringValue(subagent.lastActivity),
  };
}

export function subagentActivityTime(subagent = {}) {
  return subagent.lastActivity || subagent.spawnedAt || '';
}

export function subagentProject(subagent = {}) {
  return subagent.childProject || subagent.parentProject || '';
}

export function defaultFetchSubagents(session = '') {
  return getJSON('/api/subagents' + (session ? '?session=' + encodeURIComponent(session) : ''));
}
