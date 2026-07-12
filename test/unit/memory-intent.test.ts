import { describe, expect, it } from 'vitest';

import { detectExplicitMemoryIntent } from '../../src/memory/memory-service.js';

describe('explicit memory intent', () => {
  it.each([
    ['Chief, remember the trip is in October', 'remember'],
    ['Chief, please remember the trip is in October', 'remember'],
    ['Chief, can you correct the trip date', 'correct'],
    ['Chief, could you please forget the trip date', 'forget'],
    ['This list Chief remember no military academy', 'remember'],
    ['remember Chief ,no military academies', 'remember'],
    ['please correct Chief, dinner is at seven', 'correct'],
    ['forget Chief: dinner time', 'forget'],
  ] as const)('recognizes %s', (content, intent) => {
    expect(detectExplicitMemoryIntent(content)).toBe(intent);
  });

  it('does not treat a discussion about memory as a mutation', () => {
    expect(
      detectExplicitMemoryIntent('Chief, can you explain how memory works?'),
    ).toBeNull();
    expect(
      detectExplicitMemoryIntent("Do you remember Chief's last answer?"),
    ).toBeNull();
    expect(
      detectExplicitMemoryIntent("Remember Chief's last answer?"),
    ).toBeNull();
    expect(detectExplicitMemoryIntent('Remember Chief?')).toBeNull();
    expect(detectExplicitMemoryIntent("Correct Chief's statement?")).toBeNull();
    expect(
      detectExplicitMemoryIntent("Forget Chief's last answer?"),
    ).toBeNull();
    expect(
      detectExplicitMemoryIntent('Remember Chief from college?'),
    ).toBeNull();
    expect(detectExplicitMemoryIntent('Correct Chief about that?')).toBeNull();
    expect(
      detectExplicitMemoryIntent('Forget Chief from the meeting?'),
    ).toBeNull();
  });
});
