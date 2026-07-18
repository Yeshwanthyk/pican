import { describe, expect, it } from 'vitest';
import {
  basename,
  filterProjectsByQuery,
  isPathLikeQuery,
  moveHighlight,
  parentDirOf,
  projectsToEntries,
  withParentEntry,
} from './dir-browse.js';

describe('isPathLikeQuery', () => {
  it('treats absolute and home-relative input as path-like', () => {
    expect(isPathLikeQuery('/Users/x/project')).toBe(true);
    expect(isPathLikeQuery('~/project')).toBe(true);
    expect(isPathLikeQuery('~')).toBe(true);
  });

  it('treats plain text and empty input as project-name search', () => {
    expect(isPathLikeQuery('project')).toBe(false);
    expect(isPathLikeQuery('')).toBe(false);
    expect(isPathLikeQuery(undefined)).toBe(false);
  });
});

describe('basename', () => {
  it('returns the last path segment', () => {
    expect(basename('/Users/x/project')).toBe('project');
    expect(basename('/Users/x/project/')).toBe('project');
    expect(basename('project')).toBe('project');
    expect(basename('')).toBe('');
  });
});

describe('filterProjectsByQuery', () => {
  const projects = [
    { path: '/Users/x/pi-web' },
    { path: '/Users/x/other-repo' },
    { path: '/Users/x/nested/pican' },
  ];

  it('matches by basename or full path, case-insensitively', () => {
    expect(filterProjectsByQuery(projects, 'PI-WEB')).toEqual([{ path: '/Users/x/pi-web' }]);
    expect(filterProjectsByQuery(projects, 'nested')).toEqual([{ path: '/Users/x/nested/pican' }]);
  });

  it('returns nothing for an empty or whitespace query', () => {
    expect(filterProjectsByQuery(projects, '')).toEqual([]);
    expect(filterProjectsByQuery(projects, '   ')).toEqual([]);
  });

  it('handles a missing project list', () => {
    expect(filterProjectsByQuery(undefined, 'repo')).toEqual([]);
  });
});

describe('projectsToEntries', () => {
  it('normalizes project rows into { name, fullPath }', () => {
    expect(projectsToEntries([{ path: '/Users/x/pi-web', enabled: true }])).toEqual([
      { name: 'pi-web', fullPath: '/Users/x/pi-web' },
    ]);
  });
});

describe('parentDirOf', () => {
  it('walks up one segment', () => {
    expect(parentDirOf('/Users/x/project')).toBe('/Users/x');
    expect(parentDirOf('/Users/x/project/')).toBe('/Users/x');
    expect(parentDirOf('/Users')).toBe('/');
    expect(parentDirOf('/')).toBe('/');
  });
});

describe('withParentEntry', () => {
  it('prepends a ".." entry unless already at root', () => {
    const entries = [{ name: 'sub', fullPath: '/Users/x/sub' }];
    expect(withParentEntry(entries, '/Users/x')).toEqual([
      { name: '..', fullPath: '/Users', isParent: true },
      ...entries,
    ]);
    expect(withParentEntry(entries, '/')).toBe(entries);
  });
});

describe('moveHighlight', () => {
  it('starts at the first entry moving down from unhighlighted', () => {
    expect(moveHighlight(-1, 3, 1)).toBe(0);
  });

  it('starts at the last entry moving up from unhighlighted', () => {
    expect(moveHighlight(-1, 3, -1)).toBe(2);
  });

  it('wraps around at both ends', () => {
    expect(moveHighlight(2, 3, 1)).toBe(0);
    expect(moveHighlight(0, 3, -1)).toBe(2);
  });

  it('returns -1 for an empty list', () => {
    expect(moveHighlight(-1, 0, 1)).toBe(-1);
  });
});
