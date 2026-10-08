-- chief-legacy-checksum: chief-0005-v4
alter table context_deletion_requests
  add column source_ids_json text not null default '[]';
alter table context_deletion_requests
  add column document_ids_json text not null default '[]';
alter table context_deletion_requests
  add column memory_ids_json text not null default '[]';
alter table context_deletion_requests
  add column request_source_id text not null default '';
alter table context_forget_journal
  add column payload_json text not null default '{}';
