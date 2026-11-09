-- 上课记录支付状态改为自由文本，解除旧版固定选项约束。
-- 仅修改约束，不删除、不覆盖任何历史记录。
alter table public.class_records
  drop constraint if exists class_records_pay_status_check;
