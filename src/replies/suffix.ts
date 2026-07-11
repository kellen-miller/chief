const HONORIFIC = 'Mr. President';
const TERMINAL_HONORIFIC = /\bMr\. President[.!?]*$/u;

export function ensureTextSuffix(content: string): string {
  const trimmed = content.trim();
  if (TERMINAL_HONORIFIC.test(trimmed)) {
    return trimmed.replace(TERMINAL_HONORIFIC, HONORIFIC);
  }
  return trimmed.length === 0 ? HONORIFIC : `${trimmed} ${HONORIFIC}`;
}

export function chunkReply(content: string, maximumLength = 2_000): string[] {
  const words = content
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .flatMap((word) => splitToken(word, maximumLength));
  const finalBodyLimit = maximumLength - HONORIFIC.length - 1;
  if (finalBodyLimit < 1) {
    throw new RangeError(
      'maximumLength is too small for the required honorific',
    );
  }

  const finalWords: string[] = [];
  while (words.length > 0) {
    const candidate = [words.at(-1), ...finalWords].join(' ');
    if (candidate.length > finalBodyLimit) break;
    const word = words.pop();
    if (word === undefined) break;
    finalWords.unshift(word);
  }

  const chunks: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (candidate.length > maximumLength) {
      if (current.length > 0) chunks.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) chunks.push(current);

  chunks.push(ensureTextSuffix(finalWords.join(' ')));
  return chunks;
}

function splitToken(token: string, maximumLength: number): string[] {
  const pieces: string[] = [];
  for (let offset = 0; offset < token.length; offset += maximumLength) {
    pieces.push(token.slice(offset, offset + maximumLength));
  }
  return pieces;
}
