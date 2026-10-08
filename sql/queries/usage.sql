-- name: usageLedgerCancelDeleteUsageLedger :exec
delete from usage_ledger where id = ? and actual_usd is null;

-- name: usageLedgerBackfillRunSelectContextBackfills :one
select actual_usage_usd as actualUsd,
                  maximum_usage_usd as maximumUsd
           from context_backfills where id = ?
             and maximum_usage_usd is not null;

-- name: usageLedgerListSelectUsageLedger :many
select id, operation, reservation_usd as reservationUsd,
                backfill_run_id as backfillRunId,
                origin_backfill_run_id as originBackfillRunId,
                reservation_origin as reservationOrigin,
                work_category as workCategory, priority,
                actual_usd as actualUsd, occurred_at as occurredAt
         from usage_ledger where occurred_at >= ? and occurred_at < ?;

-- name: usageLedgerListOutstandingSelectUsageLedger :many
select id, operation, reservation_usd as reservationUsd,
                backfill_run_id as backfillRunId,
                origin_backfill_run_id as originBackfillRunId,
                reservation_origin as reservationOrigin,
                work_category as workCategory, priority,
                actual_usd as actualUsd, occurred_at as occurredAt
         from usage_ledger where actual_usd is null;

-- name: usageLedgerReconcileWithSelectContextAccountingHolds :one
select l.backfill_run_id as backfillRunId,
                  exists(
                    select 1 from context_accounting_holds h
                    where h.reservation_id = l.id
                  ) as held
           from usage_ledger l where l.id = ? and l.actual_usd is null;

-- name: usageLedgerReconcileWithUpdateUsageLedger :exec
update usage_ledger set actual_usd = ?, reconciled_at = ?
           where id = ? and actual_usd is null;

-- name: usageLedgerReconcileWithUpdateContextBackfills :exec
update context_backfills
             set actual_usage_usd = actual_usage_usd + ?, updated_at = ?
             where id = ?;

-- name: usageLedgerRecordInsertUsageLedger :exec
insert into usage_ledger
           (id, operation, work_category, priority, reservation_usd,
            actual_usd, occurred_at, occurrence_month, backfill_run_id,
            reconciled_at, reservation_origin, origin_backfill_run_id)
         values (@id, @operation, @workCategory, @priority, @reservationUsd,
                 @actualUsd, @occurredAt, @occurrenceMonth, @backfillRunId,
                 case when @actualUsd is null then null else @occurredAt end,
                 @reservationOrigin, @originBackfillRunId);
