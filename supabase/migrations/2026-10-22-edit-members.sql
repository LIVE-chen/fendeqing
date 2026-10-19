-- 迁移（#10）：编辑支出、添加 / 改名 / 退出成员。
-- members 新增 left_at（退出标记，不删行）；entries 新增 updated_at；新增 _check_entry（内部）、update_entry、add_member、rename_member、leave_member；get_ledger 返回新字段。
-- 在 Supabase SQL Editor 中整段运行；可重复执行。新库直接运行 schema.sql 即可，无需本文件。
begin;

-- 成员退出与记录编辑（#10）：退出只打标记、不删行，历史流水和余额保持不变
alter table public.members add column if not exists left_at timestamptz;
alter table public.entries add column if not exists updated_at timestamptz;

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
                  'splitMode', split_mode, 'shares', shares, 'updatedAt', updated_at)
                  order by spent_on desc, created_at desc)
                 from public.entries where ledger_id = v_id), '[]'::json)
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
  if (select count(*) from public.entries where ledger_id = v_id) >= 2000 then
    raise exception '单个账本最多 2000 条记录' using errcode = '54000';
  end if;
  select * into v_chk from public._check_entry(v_id, p_kind, p_amount, p_payer, p_participants, p_spent_on, p_split_mode, p_shares, null);
  insert into public.entries (ledger_id, kind, title, amount, payer_id, participant_ids, spent_on, split_mode, shares)
  values (v_id, p_kind, v_title, p_amount, p_payer, v_chk.o_parts, p_spent_on, coalesce(p_split_mode, 'equal'), v_chk.o_shares)
  returning id into v_new;
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
  select kind, payer_id, participant_ids into v_old
    from public.entries where id = p_entry and ledger_id = v_id for update;
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
    return v_m.id;
  end if;
  if (select count(*) from public.members where ledger_id = v_id) >= 50 then
    raise exception '成员总数（含已退出）最多 50 位' using errcode = '54000';
  end if;
  insert into public.members (ledger_id, name, position)
  values (v_id, v_name, (select coalesce(max(position), 0) + 1 from public.members where ledger_id = v_id))
  returning id into v_new;
  return v_new;
end $$;

create or replace function public.rename_member(p_token text, p_member uuid, p_name text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id uuid := public._ledger_id(p_token);
  v_name text := public._clean(p_name, 20, '成员名字');
begin
  perform 1 from public.ledgers where id = v_id for update;
  if not exists (select 1 from public.members where id = p_member and ledger_id = v_id) then
    raise exception '成员不存在' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.members where ledger_id = v_id and name = v_name and id <> p_member) then
    raise exception '已有同名成员（含已退出的成员）' using errcode = '22023';
  end if;
  update public.members set name = v_name where id = p_member;
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
  update public.members set left_at = now() where id = p_member;
end $$;

-- 权限：内部函数不对外；只开放 8 个 RPC
revoke all on function public._clean(text, int, text) from public, anon, authenticated;
revoke all on function public._ledger_id(text) from public, anon, authenticated;
revoke all on function public._check_entry(uuid, text, bigint, uuid, uuid[], date, text, bigint[], uuid[]) from public, anon, authenticated;
revoke all on function public.create_ledger(text, text[]) from public, anon, authenticated;
revoke all on function public.get_ledger(text) from public, anon, authenticated;
revoke all on function public.add_entry(text, text, text, bigint, uuid, uuid[], date, text, bigint[]) from public, anon, authenticated;
revoke all on function public.update_entry(text, uuid, text, bigint, uuid, uuid[], date, text, bigint[]) from public, anon, authenticated;
revoke all on function public.delete_entry(text, uuid) from public, anon, authenticated;
revoke all on function public.add_member(text, text) from public, anon, authenticated;
revoke all on function public.rename_member(text, uuid, text) from public, anon, authenticated;
revoke all on function public.leave_member(text, uuid) from public, anon, authenticated;
grant execute on function public.create_ledger(text, text[]) to anon, authenticated;
grant execute on function public.get_ledger(text) to anon, authenticated;
grant execute on function public.add_entry(text, text, text, bigint, uuid, uuid[], date, text, bigint[]) to anon, authenticated;
grant execute on function public.update_entry(text, uuid, text, bigint, uuid, uuid[], date, text, bigint[]) to anon, authenticated;
grant execute on function public.delete_entry(text, uuid) to anon, authenticated;
grant execute on function public.add_member(text, text) to anon, authenticated;
grant execute on function public.rename_member(text, uuid, text) to anon, authenticated;
grant execute on function public.leave_member(text, uuid) to anon, authenticated;

commit;
