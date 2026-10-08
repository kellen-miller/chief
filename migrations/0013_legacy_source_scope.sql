-- chief-legacy-checksum: chief-0013-v1
update source_events set source_scope_id = platform_source_id
where source_scope_id = '' and medium = 'text'
  and length(platform_source_id) between 17 and 20
  and platform_source_id not glob '*[^0-9]*';
