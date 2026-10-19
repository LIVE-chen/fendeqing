-- 迁移：创建账本的 IP 限流改为信任 cf-connecting-ip / x-forwarded-for 最后一段
-- 原实现取 x-forwarded-for 第一段，客户端可自带该头伪造 IP 绕过限流。
-- 在 Supabase SQL Editor 中整段运行；可重复执行。新库直接运行 schema.sql 即可，无需本文件。
begin;

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

revoke all on function public.create_ledger(text, text[]) from public, anon, authenticated;
grant execute on function public.create_ledger(text, text[]) to anon, authenticated;

commit;
