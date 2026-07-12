import { describe, expect, it } from 'vitest';

import { chunkReply, ensureTextSuffix } from '../../src/replies/suffix.js';

describe('ensureTextSuffix', () => {
  it('appends the exact honorific once', () => {
    expect(ensureTextSuffix('The meeting is at eight.')).toBe(
      'The meeting is at eight. Mr. President',
    );
  });

  it('handles empty content and rejects an impossible chunk size', () => {
    expect(ensureTextSuffix('   ')).toBe('Mr. President');
    expect(() => chunkReply('hello', 12)).toThrow(RangeError);
  });

  it('does not duplicate an existing honorific', () => {
    expect(ensureTextSuffix('Understood, Mr. President')).toBe(
      'Understood, Mr. President',
    );
  });

  it('normalizes terminal punctuation without duplicating the honorific', () => {
    expect(ensureTextSuffix('Understood, Mr. President.')).toBe(
      'Understood, Mr. President',
    );
  });
});

describe('chunkReply', () => {
  it('places the honorific only on the final Discord segment', () => {
    const chunks = chunkReply('one two three four', 20);

    expect(chunks).toEqual(['one two three', 'four Mr. President']);
  });

  it('hard-splits an oversized token within Discord limits', () => {
    const chunks = chunkReply('x'.repeat(45), 20);

    expect(chunks.every((chunk) => chunk.length <= 20)).toBe(true);
    expect(chunks.at(-1)?.endsWith('Mr. President')).toBe(true);
    expect(chunks.join('').replace(' Mr. President', '')).toBe('x'.repeat(45));
  });
});
