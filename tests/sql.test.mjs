// 在内存 Postgres（PGlite）里执行 schema.sql，验证 RPC 行为与权限隔离
// 运行：NODE_PATH=<workspace>/node_modules node tests/sql.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pgliteDir = require.resolve('@electric-sql/pglite').replace(/dist[\\/].*$/, '');
const { PGlite } = await import('file:///' + pgliteDir.replace(/\\/g, '/') + 'dist/index.js');
const { pgcrypto } = await import('file:///' + pgliteDir.replace(/\\/g, '/') + 'dist/contrib/pgcrypto.js');

const db = new PGlite({ extensions: { pgcrypto } });
// 模拟 Supabase 环境：extensions schema + anon/authenticated 角色
await db.exec(`
  create schema extensions; create extension pgcrypto schema extensions;
  create role anon nologin; create role authenticated nologin;
  grant usage on schema public, extensions to anon, authenticated;`);
await db.exec(await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8'));

const asAnon = async (sql, params) => {
  await db.exec('set role anon');
  try { return await db.query(sql, params); } finally { await db.exec('reset role'); }
};
const rejects = (p, re) => assert.rejects(p, (e) => re.test(e.message));

test('创建账本 + 记账 + 读取', async () => {
  const { rows: [{ t }] } = await asAnon(`select public.create_ledger('502 合租', array['我','小王','小李']) t`);
  assert.match(t, /^[0-9a-f]{32}$/);
  const { rows: [{ l }] } = await asAnon('select public.get_ledger($1) l', [t]);
  assert.equal(l.members.length, 3);
  const ids = l.members.map((m) => m.id);
  await asAnon(`select public.add_entry($1,'expense','房租',450000,$2,$3::uuid[],current_date)`, [t, ids[0], ids]);
  const { rows: [{ l: l2 }] } = await asAnon('select public.get_ledger($1) l', [t]);
  assert.equal(l2.entries.length, 1);
  assert.equal(l2.entries[0].amount, 450000);
});

test('anon 不能直接读写表、不能调用内部函数', async () => {
  await rejects(asAnon('select * from public.ledgers'), /permission denied/);
  await rejects(asAnon('select * from public.entries'), /permission denied/);
  await rejects(asAnon(`insert into public.ledgers(token_hash,name) values ('x','y')`), /permission denied/);
  await rejects(asAnon(`select public._ledger_id('${'a'.repeat(32)}')`), /permission denied/);
});

test('数据库只存 token 哈希', async () => {
  const { rows: [{ t }] } = await asAnon(`select public.create_ledger('a', array['x','y']) t`);
  const { rows } = await db.query('select token_hash from public.ledgers where token_hash = $1', [t]);
  assert.equal(rows.length, 0);
});

test('跨账本隔离：不能用别的账本的成员、不能删别的账本的记录', async () => {
  const { rows: [{ a }] } = await asAnon(`select public.create_ledger('A', array['a1','a2']) a`);
  const { rows: [{ b }] } = await asAnon(`select public.create_ledger('B', array['b1','b2']) b`);
  const la = (await asAnon('select public.get_ledger($1) l', [a])).rows[0].l;
  const lb = (await asAnon('select public.get_ledger($1) l', [b])).rows[0].l;
  const aIds = la.members.map((m) => m.id);
  await rejects(asAnon(`select public.add_entry($1,'expense','x',100,$2,$3::uuid[],current_date)`, [b, aIds[0], aIds]), /成员不属于该账本/);
  const { rows: [{ e }] } = await asAnon(`select public.add_entry($1,'expense','x',100,$2,$3::uuid[],current_date) e`, [a, aIds[0], aIds]);
  await rejects(asAnon('select public.delete_entry($1,$2)', [b, e]), /记录不存在/);
  assert.equal(lb.entries.length, 0);
});

test('服务端输入校验', async () => {
  await rejects(asAnon(`select public.create_ledger('a', array['x'])`), /成员数量/);
  await rejects(asAnon(`select public.create_ledger('a', array['x','x'])`), /不能重复/);
  await rejects(asAnon(`select public.create_ledger('   ', array['x','y'])`), /账本名字需要/);
  await rejects(asAnon(`select public.create_ledger('a', array['x', E'\\u202Eevil'])`), /不支持的字符/);
  await rejects(asAnon(`select public.create_ledger('a', array_fill('x'::text, array[5000]))`), /成员数量/);
  await rejects(asAnon(`select public.get_ledger('not-a-token')`), /链接无效/);
  await rejects(asAnon(`select public.get_ledger('${'0'.repeat(32)}')`), /不存在/);
  const { rows: [{ t }] } = await asAnon(`select public.create_ledger('a', array['x','y']) t`);
  const ids = (await asAnon('select public.get_ledger($1) l', [t])).rows[0].l.members.map((m) => m.id);
  const add = (kind, amt, parts, title = 't') =>
    asAnon(`select public.add_entry($1,$2,$3,$4,$5,$6::uuid[],current_date)`, [t, kind, title, amt, ids[0], parts]);
  await rejects(add('expense', 0, ids), /金额/);
  await rejects(add('expense', 1000000001, ids), /金额/);
  await rejects(add('hack', 100, ids), /类型/);
  await rejects(add('expense', 100, ids, 'x'.repeat(41)), /内容需要/);
  await rejects(add('transfer', 100, [ids[0]]), /收款人/);
});

test('同一 IP 每小时最多创建 20 个账本', async () => {
  await db.exec(`set request.headers = '{"x-forwarded-for":"9.9.9.9, 10.0.0.1"}'`);
  for (let i = 0; i < 20; i++) await asAnon(`select public.create_ledger('r', array['x','y'])`);
  await rejects(asAnon(`select public.create_ledger('r', array['x','y'])`), /太频繁/);
  await db.exec(`set request.headers = '{"x-forwarded-for":"8.8.8.8"}'`);
  await asAnon(`select public.create_ledger('r', array['x','y'])`);
});
