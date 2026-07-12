import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { generateDependencyReport } from '@discordjs/voice';
import { describe, expect, it } from 'vitest';

describe('Discord voice dependency boundary', () => {
  it('ships the pinned DAVE implementation and receive fix', async () => {
    const report = generateDependencyReport();
    const entrypoint = fileURLToPath(import.meta.resolve('@discordjs/voice'));
    const source = await readFile(entrypoint, 'utf8');

    expect(report).toContain('@discordjs/voice: 0.19.2');
    expect(report).toContain('@snazzah/davey:');
    expect(source).toContain('var DAVESession = class');
    expect(source).toContain('paddingAmount');
    expect(source).toContain('(msg[1] & 127) !== RTP_OPUS_PAYLOAD_TYPE');
  });
});
