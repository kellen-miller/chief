import { describe, expect, it } from 'vitest';

import { contextPeriod } from '../../src/context/context-period.js';

const timeZone = 'America/New_York';

describe('contextPeriod', () => {
  it('returns an ordinary hourly half-open period', () => {
    const period = contextPeriod({
      instant: Date.parse('2026-07-14T15:37:00Z'),
      tier: 'hourly',
      timeZone,
    });

    expect(period).toEqual({
      end: Date.parse('2026-07-14T16:00:00Z'),
      key: 'hourly:America/New_York:2026-07-14T15:00:00Z:2026-07-14T16:00:00Z',
      start: Date.parse('2026-07-14T15:00:00Z'),
      tier: 'hourly',
      timeZone,
    });
  });

  it('uses local midnight for daily periods', () => {
    const period = contextPeriod({
      instant: Date.parse('2026-07-14T04:15:00Z'),
      tier: 'daily',
      timeZone,
    });

    expect(period.start).toBe(Date.parse('2026-07-14T04:00:00Z'));
    expect(period.end).toBe(Date.parse('2026-07-15T04:00:00Z'));
  });

  it('uses Monday-start local weeks', () => {
    const period = contextPeriod({
      instant: Date.parse('2026-07-15T18:00:00Z'),
      tier: 'weekly',
      timeZone,
    });

    expect(period.start).toBe(Date.parse('2026-07-13T04:00:00Z'));
    expect(period.end).toBe(Date.parse('2026-07-20T04:00:00Z'));
  });

  it('skips the missing local 02:00 spring hour', () => {
    const beforeJump = contextPeriod({
      instant: Date.parse('2026-03-08T06:30:00Z'),
      tier: 'hourly',
      timeZone,
    });
    const afterJump = contextPeriod({
      instant: Date.parse('2026-03-08T07:30:00Z'),
      tier: 'hourly',
      timeZone,
    });

    expect(beforeJump).toMatchObject({
      end: Date.parse('2026-03-08T07:00:00Z'),
      start: Date.parse('2026-03-08T06:00:00Z'),
    });
    expect(afterJump).toMatchObject({
      end: Date.parse('2026-03-08T08:00:00Z'),
      start: Date.parse('2026-03-08T07:00:00Z'),
    });
  });

  it('distinguishes both repeated local 01:00 fall hours', () => {
    const daylightHour = contextPeriod({
      instant: Date.parse('2026-11-01T05:30:00Z'),
      tier: 'hourly',
      timeZone,
    });
    const standardHour = contextPeriod({
      instant: Date.parse('2026-11-01T06:30:00Z'),
      tier: 'hourly',
      timeZone,
    });

    expect(daylightHour).toMatchObject({
      end: Date.parse('2026-11-01T06:00:00Z'),
      start: Date.parse('2026-11-01T05:00:00Z'),
    });
    expect(standardHour).toMatchObject({
      end: Date.parse('2026-11-01T07:00:00Z'),
      start: Date.parse('2026-11-01T06:00:00Z'),
    });
    expect(daylightHour.key).not.toBe(standardHour.key);
  });
});
