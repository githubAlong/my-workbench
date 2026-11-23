-- Match the editable lesson type field on existing installs.
set local lock_timeout = '5s';
alter table if exists public.class_records
  drop constraint if exists class_records_class_type_check;
