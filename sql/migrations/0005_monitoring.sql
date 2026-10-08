CREATE TABLE monitoring_alerts (
  id integer primary key,
  created_at integer not null,
  delivered_at integer,
  report_json text not null
);

CREATE INDEX monitoring_alerts_created_idx
  on monitoring_alerts(created_at);
