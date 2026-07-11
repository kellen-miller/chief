export function discordPcmToRealtime(input: Buffer): Buffer {
  const discordFrames = Math.floor(input.length / 4);
  const realtimeSamples = Math.ceil(discordFrames / 2);
  const output = Buffer.alloc(realtimeSamples * 2);
  let outputOffset = 0;
  for (let frame = 0; frame < discordFrames; frame += 2) {
    const inputOffset = frame * 4;
    const left = input.readInt16LE(inputOffset);
    const right = input.readInt16LE(inputOffset + 2);
    output.writeInt16LE(Math.round((left + right) / 2), outputOffset);
    outputOffset += 2;
  }
  return output;
}

export function realtimePcmToDiscord(input: Buffer): Buffer {
  const samples = Math.floor(input.length / 2);
  const output = Buffer.alloc(samples * 8);
  for (let sampleIndex = 0; sampleIndex < samples; sampleIndex += 1) {
    const sample = input.readInt16LE(sampleIndex * 2);
    const outputOffset = sampleIndex * 8;
    output.writeInt16LE(sample, outputOffset);
    output.writeInt16LE(sample, outputOffset + 2);
    output.writeInt16LE(sample, outputOffset + 4);
    output.writeInt16LE(sample, outputOffset + 6);
  }
  return output;
}
