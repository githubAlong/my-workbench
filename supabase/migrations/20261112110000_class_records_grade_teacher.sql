-- 上课记录新增「上课年级」「上课人」两列。
-- 配合 2026-11-12 表单 / 列表顺序调整：上课日期、上课年级、上课班级、节次、学科、
-- 上课类型、上课人、代课人、课时费（元）、支付状态、备注说明。
-- 已有记录这两列留空，界面会回退显示 related_person 里的历史「原上课人」。
alter table public.class_records
  add column if not exists grade text,
  add column if not exists teacher text;
