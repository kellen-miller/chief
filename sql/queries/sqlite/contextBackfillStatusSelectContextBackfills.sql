select id as runId, run_key as runKey, status,
                eligible_count as eligibleCount,
                already_ingested_count as alreadyIngestedCount,
                eligible_bytes as eligibleBytes,
                eligible_tokens as eligibleTokens,
                estimated_usage_usd as estimatedUsageUsd,
                maximum_usage_usd as maximumUsageUsd,
                actual_usage_usd as actualUsageUsd,
                oldest_occurred_at as oldestOccurredAt,
                newest_occurred_at as newestOccurredAt,
                page_count as pageCount, pause_reason as pauseReason
         from context_backfills
         where scope_id = ? {{0}}
         order by id desc limit 1
