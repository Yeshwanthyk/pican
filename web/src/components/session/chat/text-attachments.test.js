import { describe, expect, it } from 'vitest';
import { composeMessageWithTextAttachments, textAttachmentLabel } from './text-attachments.js';

describe('text attachments', () => {
  it('formats compact chip labels', () => {
    expect(textAttachmentLabel({ original: '  hello   world  ' }, 'Text')).toBe('hello world');
    expect(textAttachmentLabel({ original: '' }, 'Text')).toBe('Text');
    expect(textAttachmentLabel({ original: 'x'.repeat(60) })).toBe('x'.repeat(48) + '…');
  });

  it('folds text attachments before the typed message', () => {
    expect(
      composeMessageWithTextAttachments('please fix', [
        { original: 'hello\nworld', note: 'rename this' },
      ]),
    ).toBe('> hello\n> world\n\nrename this\n\nplease fix');
  });

  it('returns the typed message when there are no attachments', () => {
    expect(composeMessageWithTextAttachments('plain', [])).toBe('plain');
  });
});
