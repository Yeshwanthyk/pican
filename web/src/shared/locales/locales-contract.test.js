import { describe, expect, it } from 'vitest';

const modules = import.meta.glob('./*.js', { eager: true, import: 'default' });
const locales = Object.fromEntries(
  Object.entries(modules)
    .filter(([path]) => /\/[a-z]{2,3}\.js$/.test(path))
    .map(([path, strings]) => [path.match(/\/([a-z]{2,3})\.js$/)[1], strings]),
);

describe('built-in locale contract', () => {
  it('treats English as the only key source', () => {
    const englishKeys = new Set(Object.keys(locales.en));

    for (const [code, strings] of Object.entries(locales)) {
      if (code === 'en') continue;
      const unknownKeys = Object.keys(strings).filter((key) => !englishKeys.has(key));
      expect(unknownKeys, `${code} defines keys missing from en.js`).toEqual([]);
    }
  });

  it('contains only string translations', () => {
    for (const [code, strings] of Object.entries(locales)) {
      const invalidKeys = Object.entries(strings)
        .filter(([, value]) => typeof value !== 'string')
        .map(([key]) => key);
      expect(invalidKeys, `${code} contains non-string translations`).toEqual([]);
    }
  });
});
