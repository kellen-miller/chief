export interface TextTokenPricing {
  readonly cacheWriteInputPerMillionUsd: number;
  readonly cachedInputPerMillionUsd: number;
  readonly inputPerMillionUsd: number;
  readonly outputPerMillionUsd: number;
}

export interface TextTokenUsage {
  readonly inputTokenDetails?: readonly Readonly<Record<string, number>>[];
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export function calculateTextTokenCost(
  usage: TextTokenUsage,
  pricing: TextTokenPricing,
): number {
  const cachedTokens = sumDetail(usage.inputTokenDetails, 'cached_tokens');
  const cacheWriteTokens = sumDetail(
    usage.inputTokenDetails,
    'cache_write_tokens',
  );
  const standardInputTokens = Math.max(
    0,
    usage.inputTokens - cachedTokens - cacheWriteTokens,
  );
  return (
    (standardInputTokens / 1_000_000) * pricing.inputPerMillionUsd +
    (cachedTokens / 1_000_000) * pricing.cachedInputPerMillionUsd +
    (cacheWriteTokens / 1_000_000) * pricing.cacheWriteInputPerMillionUsd +
    (usage.outputTokens / 1_000_000) * pricing.outputPerMillionUsd
  );
}

export function createResearchRequest(model: string, input: string) {
  return {
    input,
    max_output_tokens: 800,
    model,
    reasoning: { effort: 'low' as const },
    store: false,
    tools: [{ type: 'web_search' as const }],
  };
}

function sumDetail(
  details: readonly Readonly<Record<string, number>>[] | undefined,
  key: string,
): number {
  return (
    details?.reduce((total, detail) => {
      const value = detail[key] ?? 0;
      return total + (Number.isFinite(value) && value > 0 ? value : 0);
    }, 0) ?? 0
  );
}
