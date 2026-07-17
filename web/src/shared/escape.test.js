import { describe, expect, it } from 'vitest';
import { escapeHtml } from './escape.js';

describe('escapeHtml', () => {
  it('escapes text for safe insertion into HTML strings', () => {
    expect(escapeHtml('<img src=x onerror=alert(1)> & "quote"')).toBe(
      '&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quote&quot;',
    );
  });

  it('treats nullish values as empty strings', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('handles edge values correctly', () => {
    expect(escapeHtml(0)).toBe('0');
    expect(escapeHtml(false)).toBe('false');
    expect(escapeHtml('')).toBe('');
  });

  it('does not escape single quotes', () => {
    expect(escapeHtml("'")).toBe("'");
  });
});
