-- ============================================================================
--  我的工作台 · 旧首页布局安全迁移
--
--  用法：Supabase SQL Editor 中执行；不删除 wb_sync 表和任何历史数据。
--  本脚本只保留一个登录用户专属的旧布局只读入口：
--      wb_get_home_layout()
--  函数不接受客户端 key 或 UID，只按当前 JWT 的 auth.uid() 查询。
--
--  旧 wb_get / wb_put 不再授权给 PUBLIC、anon 或 authenticated。
--  历史数据仍留在 wb_sync，供后续受控备份恢复流程使用。
-- ============================================================================

-- 1) 表：RLS 全开，且不给 anon 任何直接权限
create table if not exists public.wb_sync (
  sync_key   text primary key,
  payload    jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.wb_sync enable row level security;
alter table public.wb_sync force  row level security;

-- 收回 Supabase 自动授予的默认权限（「加策略不会收回授权」，必须显式 revoke）
revoke all on public.wb_sync from anon;
revoke all on public.wb_sync from authenticated;
revoke all on public.wb_sync from public;

-- 2) 当前登录用户专属的旧布局读取函数
create or replace function public.wb_get_home_layout()
returns table (updated_at timestamptz, payload jsonb)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select s.updated_at, s.payload
  from public.wb_sync s
  where auth.uid() is not null
    and s.sync_key = 'home-layout-v1-' || auth.uid()::text
  limit 1;
$$;

revoke all on function public.wb_get_home_layout() from public;
revoke all on function public.wb_get_home_layout() from anon;
grant execute on function public.wb_get_home_layout() to authenticated;

-- 3) 旧函数如果存在，仅保留函数定义，不向客户端开放执行
do $$
begin
  if to_regprocedure('public.wb_get(text)') is not null then
    execute 'revoke all on function public.wb_get(text) from public';
    execute 'revoke all on function public.wb_get(text) from anon';
    execute 'revoke all on function public.wb_get(text) from authenticated';
  end if;
  if to_regprocedure('public.wb_put(text,jsonb)') is not null then
    execute 'revoke all on function public.wb_put(text,jsonb) from public';
    execute 'revoke all on function public.wb_put(text,jsonb) from anon';
    execute 'revoke all on function public.wb_put(text,jsonb) from authenticated';
  end if;
end
$$;

-- 4) 自检：表保持 RLS；旧 RPC 不向客户端开放；新函数只开放给登录用户
select
  c.relname as table_name,
  c.relrowsecurity as rls_enabled,
  c.relforcerowsecurity as rls_forced,
  not has_table_privilege('anon', 'public.wb_sync', 'select') as anon_no_direct_select
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'wb_sync';

select
  p.oid::regprocedure::text as function_signature,
  case a.grantee
    when 0 then 'PUBLIC'
    else pg_get_userbyid(a.grantee)
  end as grantee_name,
  a.privilege_type
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join lateral aclexplode(
  coalesce(p.proacl, acldefault('f', p.proowner))
) a
where n.nspname = 'public'
  and p.proname in ('wb_get', 'wb_put', 'wb_get_home_layout')
order by p.proname, grantee_name, a.privilege_type;
