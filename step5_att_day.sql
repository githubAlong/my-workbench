-- ============================================================================
--  step5_att_day.sql —— 每日工作表组：给「一天一组表」加一道数据库级保险
-- ============================================================================
--  什么时候跑：可选。代码不依赖它，跑之前跑之后都能正常工作。
--
--  为什么要有：前端已经是幂等的（见 js/attday.js 的 createSlot：先查已有再建），
--  但两台设备同时在「补齐」的那一秒，仍可能各建一张同一天同节次的表。
--  跑完这个脚本，数据库会直接拒绝第二张，前端收到冲突就当"已存在"处理。
--
--  为什么只建索引、不加列：
--  day_key 存在已有的 meta（jsonb）里，形如
--      '2026-11-04|高一|seat|1'
--  Postgres 支持在表达式上建唯一索引，所以不用 ALTER TABLE、不用回填数据、
--  不用改前端任何一行。老表没有 day_key，被 where 排除在外，不会卡住脚本。
-- ============================================================================

-- ① 先看一眼有没有重复（只读，不改数据）。有结果说明历史上手工建过重复表，
--    把多出来的那张删掉（或忽略）再建索引，否则第二步会失败。
select
  meta->>'day_key'          as day_key,
  count(*)                  as n,
  array_agg(id order by id) as table_ids
from public.attendance_tables
where deleted_at is null
  and meta->>'day_key' is not null
group by 1
having count(*) > 1
order by n desc;

-- ② 建唯一索引（同一天 + 同一年级 + 同类型 + 同节次，只能有一张）
create unique index if not exists attendance_tables_day_key_uniq
  on public.attendance_tables ((meta->>'day_key'))
  where deleted_at is null
    and meta->>'day_key' is not null;

-- 回滚：
--   drop index if exists public.attendance_tables_day_key_uniq;
