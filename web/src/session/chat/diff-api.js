import { getJSON } from '../../shared/api.js';

export function getDiff(sessionId, { getImpl = getJSON } = {}) {
  return getImpl(`/api/git/diff?id=${encodeURIComponent(sessionId)}`);
}
