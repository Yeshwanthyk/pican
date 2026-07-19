// Pure logic + fetch helper for the New Session directory picker
// (NewSessionModal.svelte). Kept separate from the component so the
// path-like detection, project matching, and keyboard-nav reducer are cheap
// to unit test without mounting Svelte.
import { getJSON } from '../shared/api.js';

// A typed value "looks like a path" once it starts with an absolute-path
// marker (`/`) or a home-relative marker (`~`). Anything else is treated as a
// project-name search instead of a directory browse.
export function isPathLikeQuery(value) {
  return typeof value === 'string' && (value.startsWith('/') || value.startsWith('~'));
}

// Last path segment, used for basename matching against known projects.
export function basename(path) {
  const trimmed = String(path || '').replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

// Matches known projects against a non-path-like query by basename or full
// path substring, case-insensitively. An empty/whitespace query matches
// nothing — the dropdown only appears once the user has typed something to
// narrow down, so it doesn't pop open over an empty field.
export function filterProjectsByQuery(projects, query) {
  const q = String(query || '')
    .trim()
    .toLowerCase();
  if (!q) return [];
  return (projects || []).filter((project) => {
    const path = String(project?.path || '');
    if (!path) return false;
    return path.toLowerCase().includes(q) || basename(path).toLowerCase().includes(q);
  });
}

// Normalizes project rows (shape: { path, enabled, sessionCount, source })
// into the same { name, fullPath } shape the fs-browse entries use, so the
// dropdown can render both kinds of suggestion identically.
export function projectsToEntries(projects) {
  return (projects || []).map((project) => ({
    name: basename(project?.path || ''),
    fullPath: project?.path || '',
  }));
}

// Parent directory of an absolute path (posix semantics — pican only browses
// the local filesystem the server runs on).
export function parentDirOf(path) {
  if (!path || path === '/') return '/';
  const trimmed = path.endsWith('/') && path.length > 1 ? path.slice(0, -1) : path;
  const idx = trimmed.lastIndexOf('/');
  if (idx <= 0) return '/';
  return trimmed.slice(0, idx);
}

// Prepends a synthetic ".." entry pointing one level above parentPath, unless
// parentPath is already the filesystem root.
export function withParentEntry(entries, parentPath) {
  if (!parentPath || parentPath === '/') return entries;
  return [{ name: '..', fullPath: parentDirOf(parentPath), isParent: true }, ...entries];
}

// Keyboard highlight reducer for ↑/↓: wraps around at both ends so the arrow
// keys always land on an entry once the list is non-empty, and starts at the
// first (↓) or last (↑) entry from the unhighlighted (-1) state.
export function moveHighlight(current, length, delta) {
  if (length <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : length - 1;
  return (current + delta + length) % length;
}

export function defaultBrowsePath(path) {
  return getJSON('/api/fs/browse?path=' + encodeURIComponent(path || ''));
}
