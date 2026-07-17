import { describe, expect, it } from 'vitest';
import {
  annotationLineLabel,
  annotationOffsetToLine,
  formatAnnotationsForPi,
  quoteAnnotationText,
} from './annotation-format.js';

describe('annotation format', () => {
  it('computes line labels from offsets', () => {
    const content = 'one\ntwo\nthree\n';
    expect(annotationOffsetToLine(content, 0)).toBe(1);
    expect(annotationOffsetToLine(content, 4)).toBe(2);
    expect(annotationLineLabel(content, 0, 3)).toBe('Line 1');
    expect(annotationLineLabel(content, 4, 13)).toBe('Lines 2-3');
    expect(annotationLineLabel('', 0, 1)).toBe('');
  });

  it('quotes normalized annotation text', () => {
    expect(quoteAnnotationText('  hello\n  world  ')).toBe('"hello world"');
    expect(quoteAnnotationText(null)).toBe('""');
  });

  it('formats transcript notes for pi', () => {
    const text = formatAnnotationsForPi([
      { anchorId: 'entry-e1', original: 'hello', text: 'rename this' },
    ]);

    expect(text).toContain('continuation of our current task');
    expect(text).toContain('In this conversation:');
    expect(text).toContain('"hello"');
    expect(text).toContain('  rename this');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('groups artifact notes with path and line labels', () => {
    const content = 'line one\nline two\nline three\nline four\n';
    const text = formatAnnotationsForPi(
      [
        {
          anchorId: 'artifact-art-1',
          startOffset: 0,
          endOffset: 4,
          original: 'line',
          text: 'add locale',
        },
        {
          anchorId: 'artifact-art-1',
          startOffset: 9,
          endOffset: 28,
          original: 'two..three',
          text: 'spans lines',
        },
        {
          anchorId: 'artifact-missing',
          startOffset: 0,
          endOffset: 2,
          original: 'missing',
          text: 'fallback',
        },
      ],
      {
        resolveArtifact: (id) => (id === 'art-1' ? { filePath: '/tmp/file.md', content } : null),
      },
    );

    expect(text).toContain('In /tmp/file.md:');
    expect(text).toContain('Line 1 — "line"');
    expect(text).toContain('Lines 2-3 — "two..three"');
    expect(text).toContain('In (artifact):');
    expect(text).toContain('"missing"');
  });
});
