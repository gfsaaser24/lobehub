import { type UserModelPolicy } from '@lobechat/types';
import { describe, expect, it } from 'vitest';

import { daysUntil, maskEmail, summarizePolicy } from './utils';

describe('maskEmail', () => {
  it('masks the local part but keeps the first character and domain', () => {
    expect(maskEmail('ana@editmypodcast.agency')).toBe('a***@editmypodcast.agency');
    expect(maskEmail('gabe@detailinggrowth.com')).toBe('g***@detailinggrowth.com');
  });

  it('returns the input unchanged when it is not a valid email shape', () => {
    expect(maskEmail('not-an-email')).toBe('not-an-email');
    expect(maskEmail('@leading-at.com')).toBe('@leading-at.com');
  });
});

describe('summarizePolicy', () => {
  it('treats a missing policy as unrestricted', () => {
    expect(summarizePolicy(null)).toEqual({ type: 'all' });
    expect(summarizePolicy(undefined)).toEqual({ type: 'all' });
  });

  it('treats allowedProviders "all" without model narrowing as unrestricted', () => {
    expect(summarizePolicy({ allowedProviders: 'all' })).toEqual({ type: 'all' });
    expect(summarizePolicy({ allowedModels: { openai: 'all' }, allowedProviders: 'all' })).toEqual({
      type: 'all',
    });
  });

  it('flags allowedProviders "all" with model narrowing as custom', () => {
    const policy: UserModelPolicy = {
      allowedModels: { openai: ['gpt-4o'] },
      allowedProviders: 'all',
    };
    expect(summarizePolicy(policy)).toEqual({ type: 'custom' });
  });

  it('counts explicit provider lists, including the empty list', () => {
    expect(summarizePolicy({ allowedProviders: ['openai', 'anthropic'] })).toEqual({
      count: 2,
      type: 'providers',
    });
    expect(summarizePolicy({ allowedProviders: [] })).toEqual({ count: 0, type: 'providers' });
  });
});

describe('daysUntil', () => {
  const now = new Date('2026-07-01T00:00:00Z');

  it('rounds partial days up', () => {
    expect(daysUntil('2026-07-01T12:00:00Z', now)).toBe(1);
    expect(daysUntil('2026-07-08T00:00:00Z', now)).toBe(7);
  });

  it('returns zero or negative values for expired dates', () => {
    expect(daysUntil('2026-07-01T00:00:00Z', now)).toBe(0);
    expect(daysUntil('2026-06-28T00:00:00Z', now)).toBeLessThan(0);
  });
});
