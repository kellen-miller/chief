import { describe, expect, it } from 'vitest';

import { detectExplicitMemoryIntent } from '../../src/memory/memory-service.js';

describe('explicit memory intent', () => {
  it.each([
    ['Chief, remember the trip is in October', 'remember'],
    ['Chief, please remember the trip is in October', 'remember'],
    ['Chief, can you correct the trip date', 'correct'],
    ['Chief, could you please forget the trip date', 'forget'],
    ['This list Chief remember no military academy', 'remember'],
  ] as const)('recognizes %s', (content, intent) => {
    expect(detectExplicitMemoryIntent(content)).toBe(intent);
  });

  it('does not treat a discussion about memory as a mutation', () => {
    expect(
      detectExplicitMemoryIntent('Chief, can you explain how memory works?'),
    ).toBeNull();
  });
});
