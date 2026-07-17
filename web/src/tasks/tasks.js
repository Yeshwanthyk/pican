import { getJSON } from '../shared/api.js';

export const tasksSelectionStorageKey = 'pi-tasks:selected-project';

export function normalizeTask(task = {}) {
  const execution = task.execution && typeof task.execution === 'object' ? task.execution : null;
  return {
    ...task,
    id: task.id == null ? '' : String(task.id),
    subject: typeof task.subject === 'string' ? task.subject : '',
    description: typeof task.description === 'string' ? task.description : '',
    status: ['pending', 'in_progress', 'completed'].includes(task.status) ? task.status : 'pending',
    owner: typeof task.owner === 'string' ? task.owner : '',
    agentType: typeof task.agentType === 'string' ? task.agentType : '',
    execution,
    blockedBy: Array.isArray(task.blockedBy) ? task.blockedBy.map(String) : [],
    updatedAt: typeof task.updatedAt === 'string' ? task.updatedAt : '',
  };
}

export function normalizeTaskStore(store = {}) {
  return {
    path: typeof store.path === 'string' ? store.path : '',
    scope: ['project', 'session', 'global'].includes(store.scope) ? store.scope : 'project',
    sessionId: typeof store.sessionId === 'string' ? store.sessionId : '',
    tasks: Array.isArray(store.tasks) ? store.tasks.map(normalizeTask) : [],
  };
}

export function storesForSelection(stores = [], selection = '') {
  return stores
    .map(normalizeTaskStore)
    .filter((store) =>
      selection === 'global' ? store.scope === 'global' : store.scope !== 'global',
    );
}

export function taskGroupsByStatus(stores = [], status) {
  return stores
    .map((store) => ({ ...store, tasks: store.tasks.filter((task) => task.status === status) }))
    .filter((store) => store.tasks.length > 0);
}

export function taskCount(groups = []) {
  return groups.reduce((total, group) => total + group.tasks.length, 0);
}

export function shortSessionId(sessionId = '') {
  return sessionId.length > 12 ? sessionId.slice(0, 8) + '…' : sessionId;
}

export function defaultFetchTasks(project) {
  return getJSON('/api/tasks?project=' + encodeURIComponent(project));
}

export function defaultFetchTaskOutput(project, taskId) {
  return fetch(
    '/api/tasks/output?project=' +
      encodeURIComponent(project) +
      '&taskId=' +
      encodeURIComponent(taskId),
    { headers: { Accept: 'text/plain' } },
  ).then(async (response) => {
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        const payload = await response.json();
        if (payload?.error) message = payload.error;
      } catch {}
      throw new Error(message);
    }
    return response.text();
  });
}
