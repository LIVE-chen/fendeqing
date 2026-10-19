// 在内存 Postgres（PGlite）里执行 schema.sql，验证 RPC 行为与权限隔离
// 运行：NODE_PATH=<workspace>/node_modules node tests/sql.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
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

const setHeaders = (h) => db.exec(`set request.headers = '${JSON.stringify(h)}'`);
const create = () => asAnon(`select public.create_ledger('r', array['x','y'])`);

test('同一 IP 每小时最多创建 20 个账本', async () => {
  await setHeaders({ 'cf-connecting-ip': '9.9.9.9', 'x-forwarded-for': '9.9.9.9' });
  for (let i = 0; i < 20; i++) await create();
  await rejects(create(), /太频繁/);
  await setHeaders({ 'cf-connecting-ip': '8.8.8.8', 'x-forwarded-for': '8.8.8.8' });
  await create();
});

test('伪造 x-forwarded-for 前缀无法绕过限流', async () => {
  // 线上实测：客户端自带的 XFF 会被拼在前面，cf-connecting-ip 始终是真实地址
  for (let i = 0; i < 20; i++) await setHeaders({ 'cf-connecting-ip': '7.7.7.7', 'x-forwarded-for': `1.1.1.${i}, 7.7.7.7` }), await create();
  await setHeaders({ 'cf-connecting-ip': '7.7.7.7', 'x-forwarded-for': '6.6.6.6, 7.7.7.7' });
  await rejects(create(), /太频繁/);
  // 没有 cf-connecting-ip 时兜底取 XFF 最后一段
  for (let i = 0; i < 20; i++) await setHeaders({ 'x-forwarded-for': `2.2.2.${i},5.5.5.5` }), await create();
  await setHeaders({ 'x-forwarded-for': '3.3.3.3, 5.5.5.5' });
  await rejects(create(), /太频繁/);
});

test('migrations/ 可叠加在 schema.sql 之上重复执行，权限不变', async () => {
  const dir = new URL('../supabase/migrations/', import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  assert.ok(files.length > 0);
  for (let round = 0; round < 2; round++) for (const f of files) await db.exec(await readFile(new URL(f, dir), 'utf8'));
  await setHeaders({ 'cf-connecting-ip': '4.4.4.4' });
  await create();
  await rejects(asAnon(`select public._ledger_id('${'a'.repeat(32)}')`), /permission denied/);
});

// ---------- #9 按比例 / 按金额分摊 ----------
async function newLedger3() {
  const { rows: [{ t }] } = await asAnon(`select public.create_ledger('split', array['a','b','c']) t`);
  const ids = (await asAnon('select public.get_ledger($1) l', [t])).rows[0].l.members.map((m) => m.id);
  const add = (amt, parts, mode, shares, kind = 'expense') =>
    asAnon(`select public.add_entry($1,$2,'t',$3,$4,$5::uuid[],current_date,$6,$7::bigint[]) e`, [t, kind, amt, ids[0], parts, mode, shares]);
  return { t, ids, add };
}

test('按比例 / 按金额分摊：写入并原样返回', async () => {
  await setHeaders({ 'cf-connecting-ip': '20.0.0.1' });
  const { t, ids, add } = await newLedger3();
  await add(10000, [ids[0], ids[1]], 'ratio', [2, 1]);
  await add(10000, [ids[1], ids[2]], 'amount', [3000, 7000]);
  await asAnon(`select public.add_entry($1,'expense','旧前端',600,$2,$3::uuid[],current_date)`, [t, ids[0], ids]);
  const es = (await asAnon('select public.get_ledger($1) l', [t])).rows[0].l.entries;
  const by = (m) => es.find((e) => e.splitMode === m);
  assert.deepEqual(by('ratio').shares, [2, 1]);
  assert.deepEqual(by('ratio').participantIds, [ids[0], ids[1]]);
  assert.deepEqual(by('amount').shares, [3000, 7000]);
  assert.equal(by('equal').shares, null);
});

test('分摊参数服务端校验', async () => {
  await setHeaders({ 'cf-connecting-ip': '20.0.0.2' });
  const { ids, add } = await newLedger3();
  await rejects(add(100, [ids[0], ids[1]], 'weird', [1, 1]), /分摊方式不合法/);
  await rejects(add(100, [ids[0], ids[1]], 'ratio', null), /份额/);
  await rejects(add(100, [ids[0], ids[1]], 'ratio', [1]), /份额/);
  await rejects(add(100, [ids[0], ids[0]], 'ratio', [1, 1]), /份额/);
  await rejects(add(100, [ids[0], ids[1]], 'ratio', [0, 1]), /比例/);
  await rejects(add(100, [ids[0], ids[1]], 'ratio', [1001, 1]), /比例/);
  await rejects(add(100, [ids[0], ids[1]], 'amount', [50, 49]), /之和/);
  await rejects(add(100, [ids[0], ids[1]], 'amount', [101, -1]), /之和/);
  await rejects(add(100, [ids[1]], 'ratio', [1], 'transfer'), /分摊方式不合法/);
  // 均摊时传入的 shares 被忽略
  const { rows: [{ e }] } = await add(100, ids, 'equal', [5, 5, 5]);
  assert.ok(e);
});

test('从旧版数据库升级：已有记录视为均摊，迁移可重复执行', async () => {
  const old = new PGlite({ extensions: { pgcrypto } });
  await old.exec(`create schema extensions; create extension pgcrypto schema extensions;
    create role anon nologin; create role authenticated nologin; grant usage on schema public, extensions to anon, authenticated;`);
  await old.exec(await readFile(new URL('./fixtures/schema-v1.sql', import.meta.url), 'utf8'));
  const { rows: [{ t }] } = await old.query(`select public.create_ledger('old', array['x','y']) t`);
  const ids = (await old.query('select public.get_ledger($1) l', [t])).rows[0].l.members.map((m) => m.id);
  await old.query(`select public.add_entry($1,'expense','旧',100,$2,$3::uuid[],current_date)`, [t, ids[0], ids]);
  const dir = new URL('../supabase/migrations/', import.meta.url);
  for (let round = 0; round < 2; round++)
    for (const f of (await readdir(dir)).filter((x) => x.endsWith('.sql')).sort()) await old.exec(await readFile(new URL(f, dir), 'utf8'));
  const l = (await old.query('select public.get_ledger($1) l', [t])).rows[0].l;
  assert.equal(l.entries[0].splitMode, 'equal');
  assert.equal(l.entries[0].shares, null);
  const { rows } = await old.query(`select count(*)::int n from pg_proc where proname = 'add_entry'`);
  assert.equal(rows[0].n, 1, '旧签名已删除，没有重载');
  await old.exec('set role anon');
  await old.query(`select public.add_entry($1,'expense','新',100,$2,$3::uuid[],current_date,'ratio',array[3,1]::bigint[])`, [t, ids[0], ids]);
  await old.query(`select public.add_entry($1,'expense','旧前端',100,$2,$3::uuid[],current_date)`, [t, ids[0], ids]);
  await old.exec('reset role');
  // 迁移后的函数定义与 schema.sql 完全一致（避免两份 SQL 漂移）
  const fresh = (await db.query(`select proname, md5(prosrc) m from pg_proc where proname in ('add_entry','get_ledger','create_ledger') order by 1`)).rows;
  const migrated = (await old.query(`select proname, md5(prosrc) m from pg_proc where proname in ('add_entry','get_ledger','create_ledger') order by 1`)).rows;
  assert.deepEqual(migrated, fresh);
  await old.close();
});
