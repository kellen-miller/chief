import { describe, expect, it } from 'vitest';

import {
  latchParticipantMode,
  qualifyVoiceTranscript,
} from '../../src/voice/addressing.js';

describe('voice addressing', () => {
  it('treats zero humans and empty group transcripts as unaddressed', () => {
    expect(latchParticipantMode(0)).toBe('group');
    expect(qualifyVoiceTranscript('group', '   ')).toEqual({
      addressed: false,
      prompt: '',
    });
  });

  it('latches solo mode when an utterance starts with one human', () => {
    const mode = latchParticipantMode(1);

    expect(qualifyVoiceTranscript(mode, 'What is on the agenda?')).toEqual({
      addressed: true,
      prompt: 'What is on the agenda?',
    });
  });

  it('requires Chief in a group utterance', () => {
    const mode = latchParticipantMode(2);

    expect(qualifyVoiceTranscript(mode, 'What is on the agenda?')).toEqual({
      addressed: false,
      prompt: 'What is on the agenda?',
    });
    expect(
      qualifyVoiceTranscript(mode, 'Chief, what is on the agenda?'),
    ).toEqual({
      addressed: true,
      prompt: 'what is on the agenda?',
    });
    expect(
      qualifyVoiceTranscript(mode, 'The fire chief said to evacuate.'),
    ).toEqual({
      addressed: false,
      prompt: 'The fire chief said to evacuate.',
    });
    expect(qualifyVoiceTranscript(mode, 'What is next, Chief?')).toEqual({
      addressed: true,
      prompt: 'What is next',
    });
  });

  it('does not change a latched utterance when another human joins', () => {
    const latched = latchParticipantMode(1);
    latchParticipantMode(2);

    expect(qualifyVoiceTranscript(latched, 'Continue')).toMatchObject({
      addressed: true,
    });
  });
});
