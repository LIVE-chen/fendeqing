-- 分得清 · Supabase 数据库结构（在 SQL Editor 中整段运行，可重复执行）
-- 安全模型：
--   * 表全部开启 RLS 且不建策略，并撤销 anon/authenticated 的表权限 => 无法直接读写表；
--   * 前端只能调用 4 个 SECURITY DEFINER 函数，每个都要求提供账本分享口令 token；
--   * token = 128 bit 密码学随机数，只出现在 URL 的 # 片段里；数据库只存 sha256(token)；
--   * 创建账本按 IP 限流，所有文本在服务端再次校验长度、空白和控制字符。
begin;

alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

create table if not exists public.ledgers (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  name text not null check (char_length(name) between 1 and 40),
  creator_ip_hash text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists ledgers_ip_idx on public.ledgers (creator_ip_hash, created_at);

create table if not exists public.members (
  id uuid primary key default gen_random_uuid(),
  ledger_id uuid not null references public.ledgers(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 20),
  position int not null,
  unique (ledger_id, name)
);

create table if not exists public.entries (
  id uuid primary key default gen_random_uuid(),
  ledger_id uuid not null references public.ledgers(id) on delete cascade,
  kind text not null check (kind in ('expense', 'transfer')),
  title text not null check (char_length(title) between 1 and 40),
  amount bigint not null check (amount > 0 and amount <= 1000000000),
  payer_id uuid not null references public.members(id) on delete cascade,
  participant_ids uuid[] not null check (cardinality(participant_ids) between 1 and 20),
  spent_on date not null default current_date,
  created_at timestamptz not null default now()
);
create index if not exists entries_ledger_idx on public.entries (ledger_id, created_at desc);
create index if not exists members_ledger_idx on public.members (ledger_id, position);

alter table public.ledgers enable row level security;
alter table public.members enable row level security;
alter table public.entries enable row level security;
revoke all on public.ledgers, public.members, public.entries from public, anon, authenticated;

-- 内部：清洗文本（去首尾空白含全角空格；拒绝控制字符、零宽字符和 RTL 覆盖符）
create or replace function public._clean(p text, p_max int, p_label text) returns text
language plpgsql immutable set search_path = '' as $$
declare v text;
begin
  v := regexp_replace(coalesce(p, ''), '^[\s\u3000]+|[\s\u3000]+$', '', 'g');
  if char_length(v) < 1 or char_length(v) > p_max then
    raise exception '%需要 1~% 个字', p_label, p_max using errcode = '22023';
  end if;
  if v ~ '[[:cntrl:]\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]' then
    raise exception '%包含不支持的字符', p_label using errcode = '22023';
  end if;
  return v;
end $$;

-- 内部：token -> ledger id
create or replace function public._ledger_id(p_token text) returns uuid
language plpgsql stable set search_path = '' as $$
declare v uuid;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{32}$' then
    raise exception '账本链接无效' using errcode = 'P0002';
  end if;
  select id into v from public.ledgers
   where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');
  if v is null then
    raise exception '账本不存在或已删除' using errcode = 'P0002';
  end if;
  return v;
end $$;

create or replace function public.create_ledger(p_name text, p_members text[])
returns text language plpgsql volatile security definer set search_path = '' as $$
declare
  v_token text := encode(extensions.gen_random_bytes(16), 'hex');
  v_ip text;
  v_ip_hash text;
  v_id uuid;
  v_names text[] := '{}';
  v_name text;
  n text;
begin
  -- 先检查数组大小，避免超大请求消耗 CPU
  if p_members is null or cardinality(p_members) < 2 or cardinality(p_members) > 20 then
    raise exception '成员数量需在 2~20 之间' using errcode = '22023';
  end if;
  v_name := public._clean(p_name, 40, '账本名字');
  foreach n in array p_members loop
    n := public._clean(n, 20, '成员名字');
    if n = any(v_names) then
      raise exception '成员名字不能重复' using errcode = '22023';
    end if;
    v_names := v_names || n;
  end loop;

  -- 限流：同一 IP 每小时最多 20 个账本，全站每小时最多 2000 个
  -- 优先 cf-connecting-ip（Cloudflare 设置，客户端伪造会被拒绝）；
  -- 兜底取 x-forwarded-for 的最后一段：客户端自带的值会被拼在前面，最后一段才是代理看到的真实地址（2026-10 线上实测）
  v_ip := coalesce(
    nullif(btrim(current_setting('request.headers', true)::json ->> 'cf-connecting-ip'), ''),
    nullif(btrim(regexp_replace(current_setting('request.headers', true)::json ->> 'x-forwarded-for', '^.*,', '')), ''),
    'unknown');
  v_ip_hash := encode(extensions.digest(btrim(v_ip), 'sha256'), 'hex');
  if (select count(*) from public.ledgers
       where creator_ip_hash = v_ip_hash and created_at > now() - interval '1 hour') >= 20
     or (select count(*) from public.ledgers where created_at > now() - interval '1 hour') >= 2000 then
    raise exception '创建太频繁，请稍后再试' using errcode = '54000';
  end if;

  insert into public.ledgers (token_hash, name, creator_ip_hash)
  values (encode(extensions.digest(v_token, 'sha256'), 'hex'), v_name, v_ip_hash)
  returning id into v_id;
  insert into public.members (ledger_id, name, position)
  select v_id, x.name, x.ord from unnest(v_names) with ordinality as x(name, ord);
  return v_token;
end $$;

create or replace function public.get_ledger(p_token text)
returns json language plpgsql stable security definer set search_path = '' as $$
declare v_id uuid := public._ledger_id(p_token);
begin
  return json_build_object(
    'name', (select name from public.ledgers where id = v_id),
    'members', coalesce((select json_agg(json_build_object('id', id, 'name', name) order by position)
                         from public.members where ledger_id = v_id), '[]'::json),
    'entries', coalesce((select json_agg(json_build_object(
                  'id', id, 'kind', kind, 'title', title, 'amount', amount, 'payerId', payer_id,
                  'participantIds', participant_ids, 'spentOn', spent_on, 'createdAt', created_at)
                  order by spent_on desc, created_at desc)
                 from public.entries where ledger_id = v_id), '[]'::json)
  );
end $$;

create or replace function public.add_entry(
  p_token text, p_kind text, p_title text, p_amount bigint,
  p_payer uuid, p_participants uuid[], p_spent_on date
) returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id uuid := public._ledger_id(p_token);
  v_title text := public._clean(p_title, 40, '内容');
  v_parts uuid[];
  v_new uuid;
begin
  if p_kind is null or p_kind not in ('expense', 'transfer') then
    raise exception '记录类型不合法' using errcode = '22023';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount > 1000000000 then
    raise exception '金额需大于 0 且不超过 1000 万' using errcode = '22023';
  end if;
  if p_participants is null or cardinality(p_participants) < 1 or cardinality(p_participants) > 20 then
    raise exception '分摊成员数量需在 1~20 之间' using errcode = '22023';
  end if;
  -- 允许 current_date + 1：数据库按 UTC 计日期，北京时间 0~8 点时本地"今天"比 UTC 早一天
  if p_spent_on is null or p_spent_on > current_date + 1 or p_spent_on < date '2000-01-01' then
    raise exception '日期不合法' using errcode = '22023';
  end if;

  -- 锁住账本行，避免并发请求突破 2000 条上限
  perform 1 from public.ledgers where id = v_id for update;
  if (select count(*) from public.entries where ledger_id = v_id) >= 2000 then
    raise exception '单个账本最多 2000 条记录' using errcode = '54000';
  end if;

  select array_agg(distinct p) into v_parts from unnest(p_participants) p where p is not null;
  if not exists (select 1 from public.members where id = p_payer and ledger_id = v_id)
     or v_parts is null
     or (select count(*) from public.members where ledger_id = v_id and id = any(v_parts)) <> cardinality(v_parts) then
    raise exception '成员不属于该账本' using errcode = '22023';
  end if;
  if p_kind = 'transfer' and (cardinality(v_parts) <> 1 or v_parts[1] = p_payer) then
    raise exception '还款记录需要指定一个收款人' using errcode = '22023';
  end if;

  insert into public.entries (ledger_id, kind, title, amount, payer_id, participant_ids, spent_on)
  values (v_id, p_kind, v_title, p_amount, p_payer, v_parts, p_spent_on)
  returning id into v_new;
  return v_new;
end $$;

create or replace function public.delete_entry(p_token text, p_entry uuid)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare v_id uuid := public._ledger_id(p_token);
begin
  delete from public.entries where id = p_entry and ledger_id = v_id;
  if not found then
    raise exception '记录不存在' using errcode = 'P0002';
  end if;
end $$;

-- 权限：内部函数不对外；只开放 4 个 RPC
revoke all on function public._clean(text, int, text) from public, anon, authenticated;
revoke all on function public._ledger_id(text) from public, anon, authenticated;
revoke all on function public.create_ledger(text, text[]) from public, anon, authenticated;
revoke all on function public.get_ledger(text) from public, anon, authenticated;
revoke all on function public.add_entry(text, text, text, bigint, uuid, uuid[], date) from public, anon, authenticated;
revoke all on function public.delete_entry(text, uuid) from public, anon, authenticated;
grant execute on function public.create_ledger(text, text[]) to anon, authenticated;
grant execute on function public.get_ledger(text) to anon, authenticated;
grant execute on function public.add_entry(text, text, text, bigint, uuid, uuid[], date) to anon, authenticated;
grant execute on function public.delete_entry(text, uuid) to anon, authenticated;

commit;
