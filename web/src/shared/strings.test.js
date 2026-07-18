import { describe, expect, it } from 'vitest';
import { t } from './strings.js';

describe('English UI strings', () => {
  it('resolves known keys and exposes unknown keys', () => {
    expect(t('settings.title')).toBe('Settings');
    expect(t('nope.missing')).toBe('nope.missing');
  });

  it('ignores stale language preferences', () => {
    localStorage.setItem('pi-web:v1:locale', 'es');
    expect(t('composer.send')).toBe('Send');
    localStorage.removeItem('pi-web:v1:locale');
  });

  it('interpolates parameters', () => {
    expect(t('index.sessionsCount', { count: 7 })).toBe('7 sessions');
  });
});
