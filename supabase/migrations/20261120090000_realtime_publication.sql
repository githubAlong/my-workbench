/* Realtime 发布配置
   ---------------------------------------------------------------------------
   为什么要有这条迁移：
   supabase_realtime 是「实例级」对象，不在 public schema 的导出里。
   换库、重建 Supabase 项目时，只还原表结构/策略/函数是不够的 ——
   表没加进发布，客户端订阅会静默失败，页头右上角的指示灯一直显示「未连」，
   用户会以为整个云端坏了，其实只是实时通道没开。

   表清单必须和 js/realtime.js 里的 REALTIME_TABLES 保持一致，两处要一起改。

   replica identity full 的理由：
   订阅被 RLS 过滤时，UPDATE/DELETE 的授权判定需要整行旧值。
   默认只有主键，判不了 user_id = auth.uid()，事件会被静默丢弃。 */

do $$
declare
  target text;
  targets text[] := array[
    'class_records',
    'invigilations',
    'attendance_tables',
    'attendance_rows',
    'wb_user_data'
  ];
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;

  foreach target in array targets loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = target
    ) then
      execute format('alter publication supabase_realtime add table public.%I', target);
    end if;
    execute format('alter table public.%I replica identity full', target);
  end loop;
end $$;
