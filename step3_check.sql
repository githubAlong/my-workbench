-- ============================================================================
--  第三步的自检：实时同步到底开没开
--
--  在 Supabase 后台 → SQL Editor → New query → 整段粘贴 → Run
--  这个文件只读，不改任何数据，随便跑多少次都行。
--
--  【什么时候用】
--    · 不确定自己有没有跑过 step3_realtime.sql
--    · 页头绿点显示「订阅被拒：这张表还没开启实时」
--    · 绿点是「实时」但界面不跟着变
-- ============================================================================


-- ============================================================================
--  一、发布里到底有哪几张表
--
--  期望：4 行
--        attendance_rows / attendance_tables / invigilations / lessons
--
--  少于 4 行 → step3_realtime.sql 没跑，或者没跑完。
--
--  如果这里报
--    relation "pg_publication_tables" does not exist
--  说明 Supabase 在你这个项目上把发布视图藏起来了（权限问题）。
--  那种情况跑下面第二段，它绕开这个视图直接查底表。
-- ============================================================================
select
  t.tablename      as 表名,
  '已开启实时'      as 状态
from pg_publication_tables t
where t.pubname = 'supabase_realtime'
  and t.schemaname = 'public'
order by 1;


-- ============================================================================
--  二、完整自检（和 step3_realtime.sql 末尾那张表一样）
--
--  绕开 pg_publication_tables 的限制，改成直接读 pg_publication_rel，
--  所以上面那段万一因为权限报错，这段照样能跑。
--
--  期望：四行全部 已开启实时 = true
--        并且 attendance_rows 的 整行推送 = true
-- ============================================================================
--  【刻意不显示行数】
--  pg_class.reltuples 是"上次统计之后"的估算值，刚建的表 / 刚写过还没 vacuum
--  的表会显示 -1。用户看到 -1 只会以为是坏了，不如干脆不显示。
select
  x.tbl                                   as 表名,
  (pt.tablename is not null)              as 已开启实时,
  coalesce(c.relreplident = 'f', false)   as 整行推送,
  (c.oid is not null)                     as 表已建
from (values ('lessons'), ('invigilations'), ('attendance_tables'), ('attendance_rows')) as x(tbl)
left join pg_publication_tables pt
  on pt.pubname = 'supabase_realtime'
 and pt.schemaname = 'public'
 and pt.tablename = x.tbl
left join pg_class c
  on c.relname = x.tbl
 and c.relnamespace = 'public'::regnamespace
order by 1;
