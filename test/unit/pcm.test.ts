import { describe, expect, it } from 'vitest';

import {
  discordPcmToRealtime,
  realtimePcmToDiscord,
} from '../../src/voice/pcm.js';

describe('Discord and Realtime PCM conversion', () => {
  it('downsamples 48 kHz stereo to 24 kHz mono', () => {
    const input = Buffer.alloc(16);
    input.writeInt16LE(1_000, 0);
    input.writeInt16LE(3_000, 2);
    input.writeInt16LE(2_000, 4);
    input.writeInt16LE(4_000, 6);
    input.writeInt16LE(-4_000, 8);
    input.writeInt16LE(-2_000, 10);
    input.writeInt16LE(-3_000, 12);
    input.writeInt16LE(-1_000, 14);

    const output = discordPcmToRealtime(input);

    expect([...new Int16Array(output.buffer, output.byteOffset, 2)]).toEqual([
      2_000, -3_000,
    ]);
  });

  it('upsamples 24 kHz mono to 48 kHz stereo', () => {
    const input = Buffer.alloc(4);
    input.writeInt16LE(1_000, 0);
    input.writeInt16LE(-1_000, 2);

    const output = realtimePcmToDiscord(input);

    expect([...new Int16Array(output.buffer, output.byteOffset, 8)]).toEqual([
      1_000, 1_000, 1_000, 1_000, -1_000, -1_000, -1_000, -1_000,
    ]);
  });
});
