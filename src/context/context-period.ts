import { Temporal } from '@js-temporal/polyfill';

import type { CalendarContextTier } from './context-types.js';

export interface ContextPeriod {
  readonly end: number;
  readonly key: string;
  readonly start: number;
  readonly tier: CalendarContextTier;
  readonly timeZone: string;
}

export function contextPeriod(input: {
  readonly instant: number;
  readonly tier: CalendarContextTier;
  readonly timeZone: string;
}): ContextPeriod {
  const zoned = Temporal.Instant.fromEpochMilliseconds(
    input.instant,
  ).toZonedDateTimeISO(input.timeZone);
  let start: Temporal.ZonedDateTime;
  let end: Temporal.ZonedDateTime;

  switch (input.tier) {
    case 'hourly':
      start = zoned.with({
        microsecond: 0,
        millisecond: 0,
        minute: 0,
        nanosecond: 0,
        second: 0,
      });
      end = start.add({ hours: 1 });
      break;
    case 'daily':
      start = zoned.startOfDay();
      end = start.add({ days: 1 });
      break;
    case 'weekly':
      start = zoned.startOfDay().subtract({ days: zoned.dayOfWeek - 1 });
      end = start.add({ weeks: 1 });
      break;
  }

  const startInstant = start.toInstant();
  const endInstant = end.toInstant();
  return {
    end: endInstant.epochMilliseconds,
    key: [
      input.tier,
      input.timeZone,
      startInstant.toString(),
      endInstant.toString(),
    ].join(':'),
    start: startInstant.epochMilliseconds,
    tier: input.tier,
    timeZone: input.timeZone,
  };
}
