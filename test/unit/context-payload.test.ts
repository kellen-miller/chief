import { describe, expect, it } from 'vitest';

import {
  sanitizeContextLabel,
  serializeContextPayload,
} from '../../src/context/context-payload.js';

describe('context payload', () => {
  it('uses a safe fallback for absent or fully stripped speaker labels', () => {
    expect(sanitizeContextLabel(null)).toBe('President');
    expect(sanitizeContextLabel('<@12345678901234567>\u0000')).toBe(
      'President',
    );
  });

  it('sanitizes source and recent speaker labels in the provider payload', () => {
    const payload = serializeContextPayload({
      historicalContext: [
        {
          confidence: 0.9,
          evidenceForm: 'source',
          occurredAt: 1,
          provenanceQuality: 'source-backed',
          sourceLinks: ['https://discord.com/channels/1/2/3'],
          speakerName: '  President\u0007  Example  ',
          temporalLabel: 'earlier today',
          text: 'The group discussed Project Marigold.',
        },
      ],
      memories: [],
      recentConversation: [
        {
          content: 'Recent discussion.',
          role: 'human',
          speakerName: '<@12345678901234567>',
        },
      ],
      userRequest: 'What happened?',
    });

    expect(payload.historicalContext[0]).toMatchObject({
      speakerLabel: 'President Example',
    });
    expect(payload.recentConversation[0]).toMatchObject({
      speakerLabel: 'President',
    });
  });
});
