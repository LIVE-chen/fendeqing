-- 迁移（#9）：按比例 / 按金额分摊。entries 新增 split_mode、shares 两列；add_entry 增加 2 个带默认值的参数；get_ledger 返回新字段。
-- 在 Supabase SQL Editor 中整段运行；可重复执行。已有记录自动视为均摊。新库直接运行 schema.sql 即可，无需本文件。
begin;

-- 分摊方式（#9）：equal 均摊；ratio 按份数；amount 按金额。shares 与 participant_ids 一一对应
alter table public.entries add column if not exists split_mode text not null default 'equal';
alter table public.entries add column if not exists shares bigint[];
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'entries_split_chk') then
    alter table public.entries add constraint entries_split_chk check (
      (split_mode = 'equal' and shares is null)
      or (split_mode in ('ratio', 'amount') and shares is not null
          and cardinality(shares) = cardinality(participant_ids) and array_position(shares, null) is null));
  end if;
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
                  'participantIds', participant_ids, 'spentOn', spent_on, 'createdAt', created_at,
                  'splitMode', split_mode, 'shares', shares)
                  order by spent_on desc, created_at desc)
                 from public.entries where ledger_id = v_id), '[]'::json)
  );
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
  v_mode text := coalesce(p_split_mode, 'equal');
  v_parts uuid[];
  v_shares bigint[];
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

  -- 分摊方式校验（数组长度已在上面限制为 ≤ 20，这里的遍历开销可控）
  if v_mode not in ('equal', 'ratio', 'amount') or (p_kind = 'transfer' and v_mode <> 'equal') then
    raise exception '分摊方式不合法' using errcode = '22023';
  end if;
  if v_mode = 'equal' then
    select array_agg(distinct p) into v_parts from unnest(p_participants) p where p is not null;
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
    v_parts := p_participants;
    v_shares := p_shares;
  end if;
  if not exists (select 1 from public.members where id = p_payer and ledger_id = v_id)
     or v_parts is null
     or (select count(*) from public.members where ledger_id = v_id and id = any(v_parts)) <> cardinality(v_parts) then
    raise exception '成员不属于该账本' using errcode = '22023';
  end if;
  if p_kind = 'transfer' and (cardinality(v_parts) <> 1 or v_parts[1] = p_payer) then
    raise exception '还款记录需要指定一个收款人' using errcode = '22023';
  end if;

  insert into public.entries (ledger_id, kind, title, amount, payer_id, participant_ids, spent_on, split_mode, shares)
  values (v_id, p_kind, v_title, p_amount, p_payer, v_parts, p_spent_on, v_mode, v_shares)
  returning id into v_new;
  return v_new;
end $$;

revoke all on function public.get_ledger(text) from public, anon, authenticated;
revoke all on function public.add_entry(text, text, text, bigint, uuid, uuid[], date, text, bigint[]) from public, anon, authenticated;
grant execute on function public.get_ledger(text) to anon, authenticated;
grant execute on function public.add_entry(text, text, text, bigint, uuid, uuid[], date, text, bigint[]) to anon, authenticated;

commit;
