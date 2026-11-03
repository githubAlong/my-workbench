-- ============================================================================
--  第三步：开实时同步（Realtime）
--
--  在 Supabase 后台 → SQL Editor → New query → 整段粘贴 → Run（可重复执行）
--
--  ────────────────────────────────────────────────────────────────────────
--  【Realtime 到底做了什么】
--  浏览器和 Supabase 之间一直挂着一条 WebSocket。数据库里某张表发生
--  增 / 改 / 删时，Supabase 把这一行推给「有权看到它」的浏览器。
--  于是另一台设备不用刷新，界面自己就变了。
--
--  【为什么还要跑 SQL，前端代码不是已经写好了吗】
--  Postgres 默认不会把每次改动广播出去 —— 那会产生大量无用日志。
--  必须显式把表加进 supabase_realtime 这个「发布」（publication），
--  数据库才会为这些表记录变更。不跑这一步，前端连得上、也不报错，
--  但永远收不到任何推送 —— 这是最难查的那种"看起来正常"的故障。
--
--  【为什么还要单独设 replica identity】
--  收到 UPDATE 时，前端需要知道"改的是哪一行"。
--  默认情况下 Postgres 只带主键；DELETE 更是只有主键。
--  想在推送里拿到整行旧数据（比如"原来勾的是谁"），就得把
--  replica identity 设成 FULL —— 代价是写日志稍多一些。
--  这里权衡后：考勤明细设 FULL（勾选状态来回变，拿到旧值有用），
--  其余保持默认 DEFAULT（只发新值，够了）。
-- ============================================================================


-- ============================================================================
--  一、把要实时的表加进发布
--
--  为什么用 do 块而不是一句 alter publication ... add table：
--  这个脚本要能重复跑。第二次跑时表已经在发布里，直接 add 会报
--  「relation is already member of publication」然后中断，
--  后面的语句全都不会执行 —— 用户会以为第一步就失败了。
--  所以先查 pg_publication_tables，只在缺的时候才 add。
-- ============================================================================
do $$
declare
  t text;
  tbls text[] := array[
    'lessons',
    'invigilations',
    'attendance_tables',
    'attendance_rows'
  ];
begin
  /* 发布本身必须存在。正常项目默认就有；万一被删过，这里补建。 */
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;

  foreach t in array tbls loop
    /* 表可能还没建（比如只跑了第一步就跑第三步），跳过而不是报错 */
    if not exists (
      select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = t and c.relkind = 'r'
    ) then
      raise notice '跳过 %：这张表还没建', t;
      continue;
    end if;

    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
      raise notice '已加入实时发布：%', t;
    else
      raise notice '已经在发布里，跳过：%', t;
    end if;
  end loop;
end $$;


-- ============================================================================
--  二、考勤明细用 FULL 作为行标识
--
--  默认 DEFAULT 只发主键；改成 FULL 之后，UPDATE / DELETE 的推送里
--  会带上这一行的完整旧值。老师在大屏上看考勤时，
--  「张三第 3 格从 ✓ 变成空白」这种变化能直接用，不用再回头查一次。
-- ============================================================================
alter table public.attendance_rows replica identity full;


-- ============================================================================
--  三、自检
--
--  期望：四行全部 已开启实时 = true
--        并且最下面一行 发布中的表数量 >= 4
--
--  如果某一行是 false：说明它没进发布，前端连上也收不到推送，
--  把这张截图发出来就行。
-- ============================================================================
select
  t.tablename                                    as 表名,
  (p.tablename is not null)                      as 已开启实时,
  coalesce(c.relreplident = 'f', false)          as 整行推送,
  (select count(*) from pg_constraint k
    join pg_class rc on rc.oid = k.conrelid
    join pg_namespace rn on rn.oid = rc.relnamespace
    where rn.nspname = 'public' and rc.relname = t.tablename
      and k.contype in ('p', 'u'))               as 主键或唯一键数
from (values ('lessons'), ('invigilations'), ('attendance_tables'), ('attendance_rows')) as t(tablename)
left join pg_publication_tables p
  on p.pubname = 'supabase_realtime' and p.schemaname = 'public' and p.tablename = t.tablename
left join pg_class c
  on c.relname = t.tablename and c.relnamespace = 'public'::regnamespace
order by 1;
