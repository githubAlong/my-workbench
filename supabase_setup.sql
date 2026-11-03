-- ============================================================================
--  我的工作台 · Supabase 云端存储（安全版）
--
--  用法：Supabase 后台 → 左侧 SQL Editor → New query → 整段粘贴 → Run
--  可重复执行，不会报错，也不会清掉已有数据。
--
--  ────────────────────────────────────────────────────────────────────────
--  【为什么不照抄网上的 using (true)】
--  几乎所有教程、以及 AI 自动生成的代码，都会写成：
--      create policy "sync" on wb_sync for all using (true) with check (true);
--  这一句的含义是「任何人、任何行、随便读写」。
--  而 anon key 天生是公开的 —— 它就在网页的 JS 里，开发者工具里一抄就有。
--  实测（用本地复刻 Supabase 接口跑过）后果是：
--    · 不带任何过滤 GET /rest/v1/wb_sync  →  一次拿到所有人的 sync_key
--    · 拿着别人的 key 直接 POST 覆盖      →  数据被改，本人毫无察觉
--
--  【本方案的核心思路：表根本不对外开放】
--  不把 wb_sync 暴露给 anon，而是只暴露两个函数：
--      wb_get(钥匙)  →  只返回那一行
--      wb_put(钥匙, 数据) → 只写那一行（不存在则新建）
--  钥匙必须作为参数显式传入，且必须精确相等才返回数据。
--  PostgREST 无法对表做「无条件扫描」，所以列举不出任何东西。
--
--  【能做到 / 做不到 —— 请务必读完这段】
--  能做到：不知道钥匙的人，既列举不出你的数据，也改不了你的数据。
--  做不到：严格意义上「只有我这个登录账号能读写」。
--          原因是你的工作台目前没有服务端登录体系 ——
--          账号密码存在浏览器本地，数据库不知道「你」是谁，
--          能验的只有那把 sync_key。
--          要真正按账号隔离，必须接 Supabase Auth（邮箱登录），
--          策略改成 auth.uid() = user_id。那要改动登录流程，
--          属于第二阶段，需要你点头才能动。
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

-- 2) 读函数：钥匙精确匹配才返回那一行，否则返回空
create or replace function public.wb_get(k text)
returns table (updated_at timestamptz, payload jsonb)
language sql
security definer          -- 以函数所有者身份执行，绕过 RLS 读表
set search_path = public
as $$
  select s.updated_at, s.payload
  from public.wb_sync s
  where s.sync_key = k
    and length(k) >= 32;   -- 钥匙太短直接当无效，防止空值/试探
$$;

-- 3) 写函数：不存在则新建，存在则覆盖（只动这一行）
create or replace function public.wb_put(k text, p jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.wb_sync (sync_key, payload, updated_at)
  values (k, p, now())
  on conflict (sync_key) do update
    set payload = excluded.payload,
        updated_at = excluded.updated_at
  where length(k) >= 32;
$$;

-- 4) 只把这两个函数开放给 anon，表本身一律不开放
revoke all on function public.wb_get(text)      from public;
revoke all on function public.wb_put(text, jsonb) from public;
grant execute on function public.wb_get(text)      to anon;
grant execute on function public.wb_put(text, jsonb) to anon;

-- 5) 自检：应看到「rls已开启 = true」「表对 anon 无权限 = true」
select
  c.relname                                            as 表名,
  c.relrowsecurity                                     as rls已开启,
  c.relforcerowsecurity                                as 强制RLS,
  not has_table_privilege('anon', 'public.wb_sync', 'select') as anon无直连权限,
  has_function_privilege('anon', 'public.wb_get(text)', 'execute') as 可调get函数,
  has_function_privilege('anon', 'public.wb_put(text,jsonb)', 'execute') as 可调put函数
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'wb_sync';
