create table if not exists schema_migrations (id text primary key, checksum text not null, applied_at integer not null)
