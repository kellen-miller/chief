import { describe, expect, it } from 'vitest';

import { roll } from '../../src/commands/roll.js';

describe('roll', () => {
  it('uses an exclusive upper bound to return one through max', () => {
    const result = roll(10, (minimum, maximum) => {
      expect([minimum, maximum]).toEqual([1, 11]);
      return 10;
    });

    expect(result).toBe(10);
  });

  it.each([0, -1, 1_000_001, 1.5, Number.NaN])(
    'rejects invalid max %s',
    (maximum) => {
      expect(() => roll(maximum)).toThrow(/integer from 1 through 1000000/u);
    },
  );
});
