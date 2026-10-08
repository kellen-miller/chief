-- name: monitoringPruneAlerts :exec
delete from monitoring_alerts where created_at <= @cutoff;

-- name: monitoringRecordAlert :execlastid
insert into monitoring_alerts (created_at, report_json)
values (@createdAt, @reportJson);

-- name: monitoringMarkDelivered :exec
update monitoring_alerts set delivered_at = @deliveredAt where id = @id;
