update usage_ledger set backfill_run_id = ?
       where actual_usd is null and backfill_run_id is null
         and id in (
           select usage_reservation_id from context_jobs
           where backfill_run_id = ? and usage_reservation_id is not null
         )
