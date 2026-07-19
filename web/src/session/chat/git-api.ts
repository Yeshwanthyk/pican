import { getJSON, postJSON } from "../../shared/api.js";

interface GitApiOptions {
  readonly getImpl?: (url: string) => Promise<unknown>;
  readonly postImpl?: (url: string, body: unknown) => Promise<unknown>;
}

export function getGitInfo(sessionId: string, { getImpl = getJSON }: GitApiOptions = {}) {
  return getImpl(`/api/git/info?id=${encodeURIComponent(sessionId)}`);
}

export function renameBranch(
  sessionId: string,
  name: string,
  { postImpl = postJSON }: GitApiOptions = {},
) {
  return postImpl(`/api/git/rename-branch?id=${encodeURIComponent(sessionId)}`, { name });
}
