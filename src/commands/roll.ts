import { randomInt } from 'node:crypto';

export type RandomInteger = (minimum: number, maximum: number) => number;

export function roll(
  maximum: number,
  generate: RandomInteger = randomInt,
): number {
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 1_000_000) {
    throw new RangeError('max must be an integer from 1 through 1000000');
  }

  return generate(1, maximum + 1);
}
