-- 迁移（#13）：多币种。
-- entries 新增 currency、orig_amount、fx_rate；新增内部函数 _fx_amount；add_entry、update_entry 新增 3 个外币参数（带默认值，旧前端仍可用），
-- get_ledger、get_history 返回外币字段。
-- 在 Supabase SQL Editor 中整段运行；可重复执行。新库直接运行 schema.sql 即可，无需本文件。
begin;

-- 多币种（#13）：外币支出另存原币金额（单位为该币种的 1/100）与汇率（1 外币 = fx_rate / 1000000 人民币）。
-- amount 始终是折合后的人民币分，由服务端按原币金额 × 汇率四舍五入算出；余额与结算只看 amount。
alter table public.entries add column if not exists currency text;
alter table public.entries add column if not exists orig_amount bigint;
alter table public.entries add column if not exists fx_rate bigint;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'entries_fx_chk') then
    alter table public.entries add constraint entries_fx_chk check (
      (currency is null and orig_amount is null and fx_rate is null)
      or (currency ~ '^[A-Z]{3}$' and currency <> 'CNY' and orig_amount between 1 and 1000000000000
          and fx_rate between 1 and 1000000000));
  end if;
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
                  'splitMode', split_mode, 'shares', shares, 'updatedAt', updated_at, 'recurringId', recurring_id,
                  'currency', currency, 'origAmount', orig_amount, 'fxRate', fx_rate)
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
                  'participantIds', participant_ids, 'spentOn', spent_on, 'deletedAt', deleted_at,
                  'currency', currency, 'origAmount', orig_amount) order by deleted_at desc, id)
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

-- 内部：外币支出折合人民币（#13）。三个外币参数都为空时原样返回 p_amount（人民币支出）。
-- 外币时忽略 p_amount，按 原币金额 × 汇率 / 1000000 四舍五入，避免前后端算法不一致导致余额对不上。
create or replace function public._fx_amount(
  p_kind text, p_amount bigint, p_currency text, p_orig bigint, p_rate bigint, p_split_mode text
) returns bigint language plpgsql immutable set search_path = '' as $$
begin
  if p_currency is null and p_orig is null and p_rate is null then
    return p_amount;
  end if;
  if p_kind is distinct from 'expense' then
    raise exception '还款只支持人民币' using errcode = '22023';
  end if;
  if p_currency is null or p_currency !~ '^[A-Z]{3}$' or p_currency = 'CNY' then
    raise exception '币种不合法' using errcode = '22023';
  end if;
  if p_orig is null or p_orig < 1 or p_orig > 1000000000000 then
    raise exception '外币金额需大于 0 且不超过 100 亿' using errcode = '22023';
  end if;
  if p_rate is null or p_rate < 1 or p_rate > 1000000000 then
    raise exception '汇率需大于 0 且不超过 1000' using errcode = '22023';
  end if;
  if coalesce(p_split_mode, 'equal') = 'amount' then
    raise exception '外币支出请用均摊或按比例' using errcode = '22023';
  end if;
  return round(p_orig::numeric * p_rate / 1000000)::bigint;
end $$;

-- 旧版签名：每次新增参数后先删掉，避免出现重载。
-- 新参数都带默认值，已缓存的旧前端按原参数调用仍然可用。
drop function if exists public.add_entry(text, text, text, bigint, uuid, uuid[], date);
drop function if exists public.add_entry(text, text, text, bigint, uuid, uuid[], date, text, bigint[]);
drop function if exists public.update_entry(text, uuid, text, bigint, uuid, uuid[], date, text, bigint[]);

create or replace function public.add_entry(
  p_token text, p_kind text, p_title text, p_amount bigint,
  p_payer uuid, p_participants uuid[], p_spent_on date,
  p_split_mode text default 'equal', p_shares bigint[] default null,
  p_currency text default null, p_orig_amount bigint default null, p_fx_rate bigint default null
) returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id uuid := public._ledger_id(p_token);
  v_title text := public._clean(p_title, 40, '内容');
  v_amount bigint := public._fx_amount(p_kind, p_amount, p_currency, p_orig_amount, p_fx_rate, p_split_mode);
  v_chk record;
  v_new uuid;
begin
  -- 锁住账本行，避免并发请求突破 2000 条上限，也避免与成员退出并发
  perform 1 from public.ledgers where id = v_id for update;
  if (select count(*) from public.entries where ledger_id = v_id and deleted_at is null) >= 2000 then
    raise exception '单个账本最多 2000 条记录' using errcode = '54000';
  end if;
  select * into v_chk from public._check_entry(v_id, p_kind, v_amount, p_payer, p_participants, p_spent_on, p_split_mode, p_shares, null);
  insert into public.entries (ledger_id, kind, title, amount, payer_id, participant_ids, spent_on, split_mode, shares,
                              currency, orig_amount, fx_rate)
  values (v_id, p_kind, v_title, v_amount, p_payer, v_chk.o_parts, p_spent_on, coalesce(p_split_mode, 'equal'), v_chk.o_shares,
          p_currency, p_orig_amount, p_fx_rate)
  returning id into v_new;
  perform public._log(v_id, 'add_entry', jsonb_build_object('kind', p_kind, 'title', v_title, 'amount', v_amount)
    || case when p_currency is null then '{}'::jsonb else jsonb_build_object('currency', p_currency, 'origAmount', p_orig_amount) end);
  return v_new;
end $$;

-- 编辑支出（还款只能删除，不能编辑）
create or replace function public.update_entry(
  p_token text, p_entry uuid, p_title text, p_amount bigint,
  p_payer uuid, p_participants uuid[], p_spent_on date,
  p_split_mode text default 'equal', p_shares bigint[] default null,
  p_currency text default null, p_orig_amount bigint default null, p_fx_rate bigint default null
) returns void language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id uuid := public._ledger_id(p_token);
  v_title text := public._clean(p_title, 40, '内容');
  v_amount bigint := public._fx_amount('expense', p_amount, p_currency, p_orig_amount, p_fx_rate, p_split_mode);
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
  select * into v_chk from public._check_entry(v_id, 'expense', v_amount, p_payer, p_participants, p_spent_on, p_split_mode, p_shares,
                               v_old.participant_ids || v_old.payer_id);
  -- 不传外币参数即改为人民币支出（前端编辑时总是带上当前币种）
  update public.entries
     set title = v_title, amount = v_amount, payer_id = p_payer, participant_ids = v_chk.o_parts,
         spent_on = p_spent_on, split_mode = coalesce(p_split_mode, 'equal'), shares = v_chk.o_shares, updated_at = now(),
         currency = p_currency, orig_amount = p_orig_amount, fx_rate = p_fx_rate
   where id = p_entry;
  perform public._log(v_id, 'update_entry', jsonb_build_object(
    'title', v_title, 'amount', v_amount, 'oldTitle', v_old.title, 'oldAmount', v_old.amount));
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
revoke all on function public._fx_amount(text, bigint, text, bigint, bigint, text) from public, anon, authenticated;
revoke all on function public.add_recurring(text, text, bigint, uuid, uuid[], date, text, bigint[]) from public, anon, authenticated;
revoke all on function public.delete_recurring(text, uuid) from public, anon, authenticated;
revoke all on function public.run_recurring(text) from public, anon, authenticated;
revoke all on function public._check_entry(uuid, text, bigint, uuid, uuid[], date, text, bigint[], uuid[]) from public, anon, authenticated;
revoke all on function public.create_ledger(text, text[]) from public, anon, authenticated;
revoke all on function public.get_ledger(text) from public, anon, authenticated;
revoke all on function public.get_history(text) from public, anon, authenticated;
revoke all on function public.restore_entry(text, uuid) from public, anon, authenticated;
revoke all on function public.add_entry(text, text, text, bigint, uuid, uuid[], date, text, bigint[], text, bigint, bigint) from public, anon, authenticated;
revoke all on function public.update_entry(text, uuid, text, bigint, uuid, uuid[], date, text, bigint[], text, bigint, bigint) from public, anon, authenticated;
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
grant execute on function public.add_entry(text, text, text, bigint, uuid, uuid[], date, text, bigint[], text, bigint, bigint) to anon, authenticated;
grant execute on function public.update_entry(text, uuid, text, bigint, uuid, uuid[], date, text, bigint[], text, bigint, bigint) to anon, authenticated;
grant execute on function public.delete_entry(text, uuid) to anon, authenticated;
grant execute on function public.add_member(text, text) to anon, authenticated;
grant execute on function public.rename_member(text, uuid, text) to anon, authenticated;
grant execute on function public.leave_member(text, uuid) to anon, authenticated;

commit;
