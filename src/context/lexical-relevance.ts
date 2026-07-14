const QUERY_STOP_WORDS = new Set([
  'a',
  'about',
  'an',
  'and',
  'are',
  'can',
  'decide',
  'did',
  'do',
  'for',
  'from',
  'give',
  'how',
  'i',
  'in',
  'is',
  'it',
  'me',
  'of',
  'on',
  'or',
  'our',
  'please',
  'show',
  'source',
  'that',
  'the',
  'this',
  'to',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'with',
  'you',
]);

export function extractLexicalTerms(text: string): readonly string[] {
  const tokens = text.normalize('NFKC').match(/[\p{L}\p{N}]+/gu);
  if (tokens === null) return [];
  return [
    ...new Set(tokens.map((token) => token.toLocaleLowerCase('en-US'))),
  ].filter((token) => !QUERY_STOP_WORDS.has(token));
}

export function buildLexicalQuery(
  terms: readonly string[],
): string | undefined {
  if (terms.length === 0) return undefined;
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ');
}

export function hasSufficientLexicalOverlap(
  queryTerms: readonly string[],
  candidate: string,
): boolean {
  if (queryTerms.length === 0) return false;
  const candidateTerms = new Set(extractLexicalTerms(candidate));
  const overlap = queryTerms.reduce(
    (count, term) => count + (candidateTerms.has(term) ? 1 : 0),
    0,
  );
  const requiredOverlap =
    queryTerms.length === 1 ? 1 : Math.max(2, Math.ceil(queryTerms.length / 2));
  return overlap >= requiredOverlap;
}
