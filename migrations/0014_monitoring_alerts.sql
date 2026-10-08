create table if not exists monitoring_alerts (
  id integer primary key,
  created_at integer not null,
  delivered_at integer,
  report_json text not null
);
create index if not exists monitoring_alerts_created_idx
  on monitoring_alerts(created_at);
