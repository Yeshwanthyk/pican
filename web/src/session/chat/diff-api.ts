import { getJSON } from "../../shared/api.js";

interface GetDiffOptions {
  readonly getImpl?: (url: string) => Promise<unknown>;
}

export function getDiff(sessionId: string, { getImpl = getJSON }: GetDiffOptions = {}) {
  return getImpl(`/api/git/diff?id=${encodeURIComponent(sessionId)}`);
}
