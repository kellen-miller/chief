export type ParticipantMode = 'solo' | 'group';

export interface VoiceQualification {
  readonly addressed: boolean;
  readonly prompt: string;
}

export function latchParticipantMode(humanCount: number): ParticipantMode {
  return humanCount === 1 ? 'solo' : 'group';
}

export function qualifyVoiceTranscript(
  mode: ParticipantMode,
  transcript: string,
): VoiceQualification {
  const prompt = transcript.trim();
  if (prompt.length === 0) return { addressed: false, prompt };
  if (mode === 'solo') return { addressed: true, prompt };

  const leadingAddress = /^chief\b[\s,:;.!?-]*/iu;
  const trailingAddress = /[\s,:;.!?-]+chief[.!?]*$/iu;
  if (leadingAddress.test(prompt)) {
    return {
      addressed: true,
      prompt: prompt.replace(leadingAddress, '').trim(),
    };
  }
  if (trailingAddress.test(prompt)) {
    return {
      addressed: true,
      prompt: prompt.replace(trailingAddress, '').trim(),
    };
  }
  return { addressed: false, prompt };
}
