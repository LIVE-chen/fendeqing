-- 迁移（#12）：周期账单。
-- 新增 recurring 表、entries.recurring_id；新增 _bj_today、_next_month_day、_run_recurring（内部）和 add_recurring、delete_recurring、run_recurring；
-- get_ledger 返回 recurring 与 today；leave_member 拒绝仍在周期账单里的成员。
-- 在 Supabase SQL Editor 中整段运行；可重复执行。新库直接运行 schema.sql 即可，无需本文件。
begin;

-- 周期账单（#12）：每月 day_of_month 日自动记一笔。没有后台定时任务，打开账本时由 run_recurring 补记到期的账单。
-- next_on 是下一次应记的日期（北京时间）；小月没有该日时记在月底。
create table if not exists public.recurring (
  id uuid primary key default gen_random_uuid(),
  ledger_id uuid not null references public.ledgers(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 40),
  amount bigint not null check (amount > 0 and amount <= 1000000000),
  payer_id uuid not null references public.members(id) on delete cascade,
  participant_ids uuid[] not null check (cardinality(participant_ids) between 1 and 20),
  split_mode text not null default 'equal',
  shares bigint[],
  day_of_month int not null check (day_of_month between 1 and 31),
  next_on date not null,
  created_at timestamptz not null default now(),
  check ((split_mode = 'equal' and shares is null)
         or (split_mode in ('ratio', 'amount') and shares is not null and cardinality(shares) = cardinality(participant_ids)))
);
create index if not exists recurring_ledger_idx on public.recurring (ledger_id, next_on);
alter table public.recurring enable row level security;
revoke all on public.recurring from public, anon, authenticated;
-- 由周期账单生成的流水；删除周期账单后保留流水，只断开关联
alter table public.entries add column if not exists recurring_id uuid references public.recurring(id) on delete set null;

-- 内部：北京时间的今天。中国不实行夏令时，固定 +8 小时，不依赖数据库的时区库
create or replace function public._bj_today() returns date
language sql stable set search_path = '' as $$
  select ((now() at time zone 'UTC') + interval '8 hours')::date
$$;

-- 内部：p_d 的下一个月里的第 p_dom 日；那个月没有这一天时取月底（例如 1-31 → 2-28 → 3-31）
create or replace function public._next_month_day(p_d date, p_dom int) returns date
language sql immutable set search_path = '' as $$
  select m + (least(p_dom, extract(day from (m + interval '1 month' - interval '1 day'))::int) - 1)
    from (select (date_trunc('month', p_d) + interval '1 month')::date as m) x
$$;

-- 内部：补记账本里所有到期的周期账单，返回新记的笔数。调用方需先锁住账本行，保证并发打开不会重复记。
-- 账本满 2000 条时停止补记（next_on 不前进），腾出空间后下次打开再补。
create or replace function public._run_recurring(p_ledger uuid) returns int
language plpgsql volatile set search_path = '' as $$
declare
  v_today date := public._bj_today();
  v_r record;
  v_n int := 0;
  v_live int;
begin
  select count(*) into v_live from public.entries where ledger_id = p_ledger and deleted_at is null;
  for v_r in select * from public.recurring where ledger_id = p_ledger and next_on <= v_today order by next_on, id loop
    while v_r.next_on <= v_today and v_live < 2000 loop
      insert into public.entries (ledger_id, kind, title, amount, payer_id, participant_ids, spent_on, split_mode, shares, recurring_id)
      values (p_ledger, 'expense', v_r.title, v_r.amount, v_r.payer_id, v_r.participant_ids, v_r.next_on, v_r.split_mode, v_r.shares, v_r.id);
      perform public._log(p_ledger, 'add_entry', jsonb_build_object('kind', 'expense', 'title', v_r.title, 'amount', v_r.amount, 'recurring', true));
      v_r.next_on := public._next_month_day(v_r.next_on, v_r.day_of_month);
      v_n := v_n + 1;
      v_live := v_live + 1;
    end loop;
    update public.recurring set next_on = v_r.next_on where id = v_r.id;
  end loop;
  return v_n;
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
  perform public._log(v_id, 'create', jsonb_build_object('name', v_name, 'members', to_jsonb(v_names)));
  return v_token;
end $$;

create or replace function public.get_ledger(p_token text)
returns json language plpgsql stable security definer set search_path = '' as $$
declare v_id uuid := public._ledger_id(p_token);
begin
  return json_build_object(
    'name', (select name from public.ledgers where id = v_id),
    'members', coalesce((select json_agg(json_build_object('id', id, 'name', name, 'left', left_at is not null)
                         order by position) from public.members where ledger_id = v_id), '[]'::json),
    'entries', coalesce((select json_agg(json_build_object(
                  'id', id, 'kind', kind, 'title', title, 'amount', amount, 'payerId', payer_id,
                  'participantIds', participant_ids, 'spentOn', spent_on, 'createdAt', created_at,
                  'splitMode', split_mode, 'shares', shares, 'updatedAt', updated_at, 'recurringId', recurring_id)
                  order by spent_on desc, created_at desc)
                 from public.entries where ledger_id = v_id and deleted_at is null), '[]'::json),
    'recurring', coalesce((select json_agg(json_build_object(
                  'id', id, 'title', title, 'amount', amount, 'payerId', payer_id, 'participantIds', participant_ids,
                  'splitMode', split_mode, 'shares', shares, 'dayOfMonth', day_of_month, 'nextOn', next_on)
                  order by created_at, id)
                 from public.recurring where ledger_id = v_id), '[]'::json),
    -- 服务端的"今天"（北京时间），前端据此判断是否有到期的周期账单，不受手机时区影响
    'today', public._bj_today()
  );
end $$;

-- 历史：最近删除的记录（可恢复）与操作日志，各取最近 100 条
create or replace function public.get_history(p_token text)
returns json language plpgsql stable security definer set search_path = '' as $$
declare v_id uuid := public._ledger_id(p_token);
begin
  return json_build_object(
    'deleted', coalesce((select json_agg(json_build_object(
                  'id', id, 'kind', kind, 'title', title, 'amount', amount, 'payerId', payer_id,
                  'participantIds', participant_ids, 'spentOn', spent_on, 'deletedAt', deleted_at) order by deleted_at desc, id)
                 from (select * from public.entries where ledger_id = v_id and deleted_at is not null
                        order by deleted_at desc, id limit 100) d), '[]'::json),
    'activities', coalesce((select json_agg(json_build_object('at', at, 'action', action, 'detail', detail) order by id desc)
                 from (select * from public.activities where ledger_id = v_id order by id desc limit 100) a), '[]'::json)
  );
end $$;

-- 内部：记一笔 / 编辑共用的校验，返回规范化后的参与人与份额。
-- p_extra：编辑时允许保留的原记录成员（即使已退出）；还款允许任何成员，保证退出成员也能结清。
create or replace function public._check_entry(
  p_ledger uuid, p_kind text, p_amount bigint, p_payer uuid, p_participants uuid[],
  p_spent_on date, p_split_mode text, p_shares bigint[], p_extra uuid[],
  out o_parts uuid[], out o_shares bigint[]
) language plpgsql stable set search_path = '' as $$
declare v_mode text := coalesce(p_split_mode, 'equal');
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
  -- 分摊方式校验（数组长度已在上面限制为 ≤ 20，这里的遍历开销可控）
  if v_mode not in ('equal', 'ratio', 'amount') or (p_kind = 'transfer' and v_mode <> 'equal') then
    raise exception '分摊方式不合法' using errcode = '22023';
  end if;
  if v_mode = 'equal' then
    select array_agg(distinct p) into o_parts from unnest(p_participants) p where p is not null;
  else
    -- 份额与参与人按位置一一对应，所以不能去重重排，只能拒绝重复
    if p_shares is null or cardinality(p_shares) <> cardinality(p_participants)
       or array_position(p_participants, null) is not null or array_position(p_shares, null) is not null
       or (select count(distinct p) from unnest(p_participants) p) <> cardinality(p_participants) then
      raise exception '每位分摊成员都需要填写份额' using errcode = '22023';
    end if;
    if v_mode = 'ratio' and exists (select 1 from unnest(p_shares) s where s < 1 or s > 1000) then
      raise exception '比例需为 1~1000 的整数' using errcode = '22023';
    end if;
    if v_mode = 'amount' and (exists (select 1 from unnest(p_shares) s where s < 1 or s > 1000000000)
       or (select sum(s) from unnest(p_shares) s) <> p_amount) then
      raise exception '各人金额之和需等于总金额' using errcode = '22023';
    end if;
    o_parts := p_participants;
    o_shares := p_shares;
  end if;
  if not exists (select 1 from public.members where id = p_payer and ledger_id = p_ledger)
     or o_parts is null
     or (select count(*) from public.members where ledger_id = p_ledger and id = any(o_parts)) <> cardinality(o_parts) then
    raise exception '成员不属于该账本' using errcode = '22023';
  end if;
  if p_kind = 'expense' and exists (
       select 1 from public.members
        where ledger_id = p_ledger and left_at is not null
          and (id = p_payer or id = any(o_parts)) and not (id = any(coalesce(p_extra, '{}')))) then
    raise exception '已退出的成员不能参与新的支出' using errcode = '22023';
  end if;
  if p_kind = 'transfer' and (cardinality(o_parts) <> 1 or o_parts[1] = p_payer) then
    raise exception '还款记录需要指定一个收款人' using errcode = '22023';
  end if;
end $$;

-- 旧版 7 参数签名：新增分摊参数后先删掉，避免出现重载。
-- 新签名的两个参数带默认值，已缓存的旧前端按原参数调用仍然可用。
drop function if exists public.add_entry(text, text, text, bigint, uuid, uuid[], date);

create or replace function public.add_entry(
  p_token text, p_kind text, p_title text, p_amount bigint,
  p_payer uuid, p_participants uuid[], p_spent_on date,
  p_split_mode text default 'equal', p_shares bigint[] default null
) returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id uuid := public._ledger_id(p_token);
  v_title text := public._clean(p_title, 40, '内容');
  v_chk record;
  v_new uuid;
begin
  -- 锁住账本行，避免并发请求突破 2000 条上限，也避免与成员退出并发
  perform 1 from public.ledgers where id = v_id for update;
  if (select count(*) from public.entries where ledger_id = v_id and deleted_at is null) >= 2000 then
    raise exception '单个账本最多 2000 条记录' using errcode = '54000';
  end if;
  select * into v_chk from public._check_entry(v_id, p_kind, p_amount, p_payer, p_participants, p_spent_on, p_split_mode, p_shares, null);
  insert into public.entries (ledger_id, kind, title, amount, payer_id, participant_ids, spent_on, split_mode, shares)
  values (v_id, p_kind, v_title, p_amount, p_payer, v_chk.o_parts, p_spent_on, coalesce(p_split_mode, 'equal'), v_chk.o_shares)
  returning id into v_new;
  perform public._log(v_id, 'add_entry', jsonb_build_object('kind', p_kind, 'title', v_title, 'amount', p_amount));
  return v_new;
end $$;

-- 编辑支出（还款只能删除，不能编辑）
create or replace function public.update_entry(
  p_token text, p_entry uuid, p_title text, p_amount bigint,
  p_payer uuid, p_participants uuid[], p_spent_on date,
  p_split_mode text default 'equal', p_shares bigint[] default null
) returns void language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id uuid := public._ledger_id(p_token);
  v_title text := public._clean(p_title, 40, '内容');
  v_old record;
  v_chk record;
begin
  perform 1 from public.ledgers where id = v_id for update;
  select kind, title, amount, payer_id, participant_ids into v_old
    from public.entries where id = p_entry and ledger_id = v_id and deleted_at is null for update;
  if not found then
    raise exception '记录不存在' using errcode = 'P0002';
  end if;
  if v_old.kind <> 'expense' then
    raise exception '还款记录不能编辑，可以删除后重新标记' using errcode = '22023';
  end if;
  select * into v_chk from public._check_entry(v_id, 'expense', p_amount, p_payer, p_participants, p_spent_on, p_split_mode, p_shares,
                               v_old.participant_ids || v_old.payer_id);
  update public.entries
     set title = v_title, amount = p_amount, payer_id = p_payer, participant_ids = v_chk.o_parts,
         spent_on = p_spent_on, split_mode = coalesce(p_split_mode, 'equal'), shares = v_chk.o_shares, updated_at = now()
   where id = p_entry;
  perform public._log(v_id, 'update_entry', jsonb_build_object(
    'title', v_title, 'amount', p_amount, 'oldTitle', v_old.title, 'oldAmount', v_old.amount));
end $$;

-- 添加成员；名字与已退出成员相同时恢复该成员
create or replace function public.add_member(p_token text, p_name text)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id uuid := public._ledger_id(p_token);
  v_name text := public._clean(p_name, 20, '成员名字');
  v_m record;
  v_new uuid;
begin
  perform 1 from public.ledgers where id = v_id for update;
  select id, left_at into v_m from public.members where ledger_id = v_id and name = v_name;
  if found and v_m.left_at is null then
    raise exception '已有同名成员' using errcode = '22023';
  end if;
  if (select count(*) from public.members where ledger_id = v_id and left_at is null) >= 20 then
    raise exception '最多 20 位成员' using errcode = '54000';
  end if;
  if found then
    update public.members set left_at = null where id = v_m.id;
    perform public._log(v_id, 'restore_member', jsonb_build_object('name', v_name));
    return v_m.id;
  end if;
  if (select count(*) from public.members where ledger_id = v_id) >= 50 then
    raise exception '成员总数（含已退出）最多 50 位' using errcode = '54000';
  end if;
  insert into public.members (ledger_id, name, position)
  values (v_id, v_name, (select coalesce(max(position), 0) + 1 from public.members where ledger_id = v_id))
  returning id into v_new;
  perform public._log(v_id, 'add_member', jsonb_build_object('name', v_name));
  return v_new;
end $$;

create or replace function public.rename_member(p_token text, p_member uuid, p_name text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id uuid := public._ledger_id(p_token);
  v_name text := public._clean(p_name, 20, '成员名字');
  v_old text;
begin
  perform 1 from public.ledgers where id = v_id for update;
  select name into v_old from public.members where id = p_member and ledger_id = v_id;
  if not found then
    raise exception '成员不存在' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.members where ledger_id = v_id and name = v_name and id <> p_member) then
    raise exception '已有同名成员（含已退出的成员）' using errcode = '22023';
  end if;
  update public.members set name = v_name where id = p_member;
  perform public._log(v_id, 'rename_member', jsonb_build_object('name', v_name, 'oldName', v_old));
end $$;

-- 退出账本：只打标记，历史记录与余额不变。余额是否结清由前端把关（算法只在 settle.js 实现一份）
create or replace function public.leave_member(p_token text, p_member uuid)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare v_id uuid := public._ledger_id(p_token);
begin
  perform 1 from public.ledgers where id = v_id for update;
  if not exists (select 1 from public.members where id = p_member and ledger_id = v_id and left_at is null) then
    raise exception '成员不存在或已退出' using errcode = 'P0002';
  end if;
  if (select count(*) from public.members where ledger_id = v_id and left_at is null) <= 2 then
    raise exception '账本至少需要 2 位成员' using errcode = '22023';
  end if;
  if exists (select 1 from public.recurring where ledger_id = v_id and (payer_id = p_member or p_member = any(participant_ids))) then
    raise exception '该成员还在周期账单里，请先删除相关的周期账单' using errcode = '22023';
  end if;
  update public.members set left_at = now() where id = p_member;
  perform public._log(v_id, 'leave_member', jsonb_build_object('name', (select name from public.members where id = p_member)));
end $$;

-- 新建周期账单：p_start_on 是第一次记账的日期（也决定每月几号），最早一年前、最晚一年后。
-- 首次日期不晚于今天时立即补记，返回 { id, added }。
create or replace function public.add_recurring(
  p_token text, p_title text, p_amount bigint, p_payer uuid, p_participants uuid[], p_start_on date,
  p_split_mode text default 'equal', p_shares bigint[] default null
) returns json language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id uuid := public._ledger_id(p_token);
  v_title text := public._clean(p_title, 40, '内容');
  v_chk record;
  v_new uuid;
  v_added int;
begin
  perform 1 from public.ledgers where id = v_id for update;
  if (select count(*) from public.recurring where ledger_id = v_id) >= 20 then
    raise exception '每个账本最多 20 个周期账单' using errcode = '54000';
  end if;
  if p_start_on is null or p_start_on < public._bj_today() - 366 or p_start_on > public._bj_today() + 366 then
    raise exception '首次日期需在前后一年内' using errcode = '22023';
  end if;
  -- 与记一笔相同的校验；_check_entry 的日期检查（不晚于明天）对未来的首次日期不适用，这里传今天代替
  select * into v_chk from public._check_entry(v_id, 'expense', p_amount, p_payer, p_participants,
    least(p_start_on, public._bj_today()), p_split_mode, p_shares, null);
  insert into public.recurring (ledger_id, title, amount, payer_id, participant_ids, split_mode, shares, day_of_month, next_on)
  values (v_id, v_title, p_amount, p_payer, v_chk.o_parts, coalesce(p_split_mode, 'equal'), v_chk.o_shares,
          extract(day from p_start_on)::int, p_start_on)
  returning id into v_new;
  perform public._log(v_id, 'add_recurring', jsonb_build_object('title', v_title, 'amount', p_amount, 'day', extract(day from p_start_on)::int));
  v_added := public._run_recurring(v_id);
  return json_build_object('id', v_new, 'added', v_added);
end $$;

-- 删除周期账单：只停止以后的自动记账，已经记下的流水保留
create or replace function public.delete_recurring(p_token text, p_recurring uuid)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id uuid := public._ledger_id(p_token);
  v_r record;
begin
  perform 1 from public.ledgers where id = v_id for update;
  delete from public.recurring where id = p_recurring and ledger_id = v_id returning title, amount into v_r;
  if not found then
    raise exception '周期账单不存在' using errcode = 'P0002';
  end if;
  perform public._log(v_id, 'delete_recurring', jsonb_build_object('title', v_r.title, 'amount', v_r.amount));
end $$;

-- 打开账本时调用：补记到期的周期账单，返回新记的笔数。没有到期的账单时不加锁、直接返回 0
create or replace function public.run_recurring(p_token text)
returns int language plpgsql volatile security definer set search_path = '' as $$
declare v_id uuid := public._ledger_id(p_token);
begin
  if not exists (select 1 from public.recurring where ledger_id = v_id and next_on <= public._bj_today()) then
    return 0;
  end if;
  perform 1 from public.ledgers where id = v_id for update;
  return public._run_recurring(v_id);
end $$;

-- 删除 = 移入回收站（软删除）。顺带清理：超过 30 天的、超出 100 条的已删除记录才真正删掉
create or replace function public.delete_entry(p_token text, p_entry uuid)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id uuid := public._ledger_id(p_token);
  v_e record;
begin
  perform 1 from public.ledgers where id = v_id for update;
  update public.entries set deleted_at = now()
   where id = p_entry and ledger_id = v_id and deleted_at is null
  returning kind, title, amount into v_e;
  if not found then
    raise exception '记录不存在' using errcode = 'P0002';
  end if;
  delete from public.entries where ledger_id = v_id and deleted_at is not null
     and (deleted_at < now() - interval '30 days' or id in (
       select id from public.entries where ledger_id = v_id and deleted_at is not null
        order by deleted_at desc, id offset 100));
  perform public._log(v_id, 'delete_entry', jsonb_build_object('kind', v_e.kind, 'title', v_e.title, 'amount', v_e.amount));
end $$;

-- 从回收站恢复。记录涉及的成员已退出也照样恢复：恢复的是历史，不是新支出
create or replace function public.restore_entry(p_token text, p_entry uuid)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id uuid := public._ledger_id(p_token);
  v_e record;
begin
  perform 1 from public.ledgers where id = v_id for update;
  if (select count(*) from public.entries where ledger_id = v_id and deleted_at is null) >= 2000 then
    raise exception '单个账本最多 2000 条记录' using errcode = '54000';
  end if;
  update public.entries set deleted_at = null
   where id = p_entry and ledger_id = v_id and deleted_at is not null
  returning kind, title, amount into v_e;
  if not found then
    raise exception '记录不存在或已恢复' using errcode = 'P0002';
  end if;
  perform public._log(v_id, 'restore_entry', jsonb_build_object('kind', v_e.kind, 'title', v_e.title, 'amount', v_e.amount));
end $$;

-- 权限：内部函数不对外；只开放 13 个 RPC
revoke all on function public._clean(text, int, text) from public, anon, authenticated;
revoke all on function public._ledger_id(text) from public, anon, authenticated;
revoke all on function public._log(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public._bj_today() from public, anon, authenticated;
revoke all on function public._next_month_day(date, int) from public, anon, authenticated;
revoke all on function public._run_recurring(uuid) from public, anon, authenticated;
revoke all on function public.add_recurring(text, text, bigint, uuid, uuid[], date, text, bigint[]) from public, anon, authenticated;
revoke all on function public.delete_recurring(text, uuid) from public, anon, authenticated;
revoke all on function public.run_recurring(text) from public, anon, authenticated;
revoke all on function public._check_entry(uuid, text, bigint, uuid, uuid[], date, text, bigint[], uuid[]) from public, anon, authenticated;
revoke all on function public.create_ledger(text, text[]) from public, anon, authenticated;
revoke all on function public.get_ledger(text) from public, anon, authenticated;
revoke all on function public.get_history(text) from public, anon, authenticated;
revoke all on function public.restore_entry(text, uuid) from public, anon, authenticated;
revoke all on function public.add_entry(text, text, text, bigint, uuid, uuid[], date, text, bigint[]) from public, anon, authenticated;
revoke all on function public.update_entry(text, uuid, text, bigint, uuid, uuid[], date, text, bigint[]) from public, anon, authenticated;
revoke all on function public.delete_entry(text, uuid) from public, anon, authenticated;
revoke all on function public.add_member(text, text) from public, anon, authenticated;
revoke all on function public.rename_member(text, uuid, text) from public, anon, authenticated;
revoke all on function public.leave_member(text, uuid) from public, anon, authenticated;
grant execute on function public.create_ledger(text, text[]) to anon, authenticated;
grant execute on function public.get_ledger(text) to anon, authenticated;
grant execute on function public.get_history(text) to anon, authenticated;
grant execute on function public.add_recurring(text, text, bigint, uuid, uuid[], date, text, bigint[]) to anon, authenticated;
grant execute on function public.delete_recurring(text, uuid) to anon, authenticated;
grant execute on function public.run_recurring(text) to anon, authenticated;
grant execute on function public.restore_entry(text, uuid) to anon, authenticated;
grant execute on function public.add_entry(text, text, text, bigint, uuid, uuid[], date, text, bigint[]) to anon, authenticated;
grant execute on function public.update_entry(text, uuid, text, bigint, uuid, uuid[], date, text, bigint[]) to anon, authenticated;
grant execute on function public.delete_entry(text, uuid) to anon, authenticated;
grant execute on function public.add_member(text, text) to anon, authenticated;
grant execute on function public.rename_member(text, uuid, text) to anon, authenticated;
grant execute on function public.leave_member(text, uuid) to anon, authenticated;

commit;
