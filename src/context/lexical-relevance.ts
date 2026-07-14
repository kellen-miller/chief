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
export interface LexicalTermSet {
  readonly all: readonly string[];
  readonly relevance: readonly string[];
}

interface PreservedLexicalTerm {
  readonly normalized: string;
  readonly raw: string;
  readonly rawIndex: number;
}

export function extractLexicalTermSet(text: string): LexicalTermSet {
  const terms = preservedLexicalTerms(text);
  if (terms.length === 0) return { all: [], relevance: [] };
  const formDistinctive = terms.filter(({ raw }) =>
    hasDistinctiveTokenForm(raw),
  );
  const onlySentenceInitialTitle =
    formDistinctive.length === 1 &&
    formDistinctive[0]?.rawIndex === 0 &&
    !hasIdentifierForm(formDistinctive[0].raw);
  const relevance =
    formDistinctive.length > 0 && !onlySentenceInitialTitle
      ? formDistinctive
      : [longestTerm(terms)];
  return {
    all: terms.map(({ normalized }) => normalized),
    relevance: relevance.map(({ normalized }) => normalized),
  };
}

export function buildLexicalQuery(
  terms: readonly string[],
): string | undefined {
  if (terms.length === 0) return undefined;
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ');
}

export function hasSufficientLexicalOverlap(
  relevanceTerms: readonly string[],
  candidate: string,
): boolean {
  if (relevanceTerms.length === 0) return false;
  const candidateTerms = new Set(extractLexicalTermSet(candidate).all);
  const overlap = relevanceTerms.reduce(
    (count, term) => count + (candidateTerms.has(term) ? 1 : 0),
    0,
  );
  return overlap >= Math.ceil(relevanceTerms.length / 2);
}

export function hasCompleteLexicalAnchor(
  relevanceTerms: readonly string[],
  candidate: string,
): boolean {
  if (relevanceTerms.length === 0) return false;
  const candidateTerms = new Set(extractLexicalTermSet(candidate).all);
  return relevanceTerms.every((term) => candidateTerms.has(term));
}

function preservedLexicalTerms(text: string): readonly PreservedLexicalTerm[] {
  const matches = [...text.normalize('NFKC').matchAll(/[\p{L}\p{N}]+/gu)];
  const seen = new Set<string>();
  return matches.flatMap((match, rawIndex) => {
    const raw = match[0];
    const normalized = raw.toLocaleLowerCase('en-US');
    if (QUERY_STOP_WORDS.has(normalized) || seen.has(normalized)) return [];
    seen.add(normalized);
    return [{ normalized, raw, rawIndex }];
  });
}

function hasDistinctiveTokenForm(raw: string): boolean {
  return /^\p{Lu}/u.test(raw) || hasIdentifierForm(raw);
}

function hasIdentifierForm(raw: string): boolean {
  return /\p{N}/u.test(raw) || /[\p{L}\p{N}]\p{Lu}/u.test(raw);
}

function longestTerm(
  terms: readonly PreservedLexicalTerm[],
): PreservedLexicalTerm {
  return terms.reduce((longest, term) =>
    Array.from(term.normalized).length > Array.from(longest.normalized).length
      ? term
      : longest,
  );
}
