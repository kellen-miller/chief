import { describe, expect, it } from 'vitest';

import { VoiceSuffixEnforcer } from '../../src/voice/voice-suffix.js';

describe('VoiceSuffixEnforcer', () => {
  it('does not append the fallback when the transcript already ends correctly', () => {
    const enforcer = new VoiceSuffixEnforcer(Buffer.from('fallback'), 100);
    enforcer.push(Buffer.from('natural'));
    enforcer.addTranscript('Certainly, Mr. President');

    expect(Buffer.concat(enforcer.complete()).toString()).toBe('natural');
  });

  it('appends a validated fallback when the model omits the suffix', () => {
    const enforcer = new VoiceSuffixEnforcer(Buffer.from(' suffix'), 100);
    enforcer.push(Buffer.from('answer'));
    enforcer.addTranscript('Certainly.');

    expect(Buffer.concat(enforcer.complete()).toString()).toBe('answer suffix');
  });

  it('discards buffered audio after interruption', () => {
    const enforcer = new VoiceSuffixEnforcer(Buffer.from(' suffix'), 100);
    enforcer.push(Buffer.from('partial'));

    enforcer.interrupt();

    expect(enforcer.complete()).toEqual([]);
    expect(enforcer.push(Buffer.from('late'))).toEqual([]);
    enforcer.addTranscript('ignored');
  });

  it('flushes audio beyond the protected tail', () => {
    const enforcer = new VoiceSuffixEnforcer(Buffer.from('!'), 3);
    expect(enforcer.push(Buffer.from('abcdef'))).toEqual([Buffer.from('abc')]);
    enforcer.addTranscript('No suffix');
    expect(Buffer.concat(enforcer.complete()).toString()).toBe('def!');
  });

  it('rejects unusable fallback configuration', () => {
    expect(() => new VoiceSuffixEnforcer(Buffer.alloc(0))).toThrow(/empty/u);
    expect(() => new VoiceSuffixEnforcer(Buffer.from('x'), 0)).toThrow(
      RangeError,
    );
  });
});
