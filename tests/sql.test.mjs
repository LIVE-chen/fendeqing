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
  // 迁移后 public 下全部函数的签名、函数体（去空白比较：Windows 签出可能是 CRLF）、anon 权限与 schema.sql 新建的库完全一致
  const fresh = (await db.query(`select p.proname, pg_get_function_identity_arguments(p.oid) args, md5(regexp_replace(p.prosrc, '\\s', '', 'g')) m, has_function_privilege('anon', p.oid, 'execute') anon from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' order by 1, 2`)).rows;
  const migrated = (await old.query(`select p.proname, pg_get_function_identity_arguments(p.oid) args, md5(regexp_replace(p.prosrc, '\\s', '', 'g')) m, has_function_privilege('anon', p.oid, 'execute') anon from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' order by 1, 2`)).rows;
  assert.deepEqual(migrated, fresh);
  await old.close();
});

// ---------- #10 编辑记录、增删成员 ----------
async function ledgerWith(names, ip) {
  await setHeaders({ 'cf-connecting-ip': ip });
  const { rows: [{ t }] } = await asAnon(`select public.create_ledger('m', $1::text[]) t`, [names]);
  const get = async () => (await asAnon('select public.get_ledger($1) l', [t])).rows[0].l;
  const ids = (await get()).members.map((m) => m.id);
  const addE = (payer, parts, kind = 'expense', amt = 300) =>
    asAnon(`select public.add_entry($1,$2,'t',$3,$4,$5::uuid[],current_date) e`, [t, kind, amt, payer, parts]).then((r) => r.rows[0].e);
  return { t, ids, get, addE };
}

test('成员：添加、同名拒绝、退出后同名恢复、在账 20 人上限', async () => {
  const { t, ids, get } = await ledgerWith(['a', 'b'], '30.0.0.1');
  const { rows: [{ c }] } = await asAnon('select public.add_member($1, $2) c', [t, ' c ']);
  let l = await get();
  assert.deepEqual(l.members.map((m) => [m.name, m.left]), [['a', false], ['b', false], ['c', false]]);
  await rejects(asAnon('select public.add_member($1, $2)', [t, 'a']), /同名/);
  await asAnon('select public.leave_member($1, $2)', [t, c]);
  l = await get();
  assert.equal(l.members.find((m) => m.id === c).left, true);
  const { rows: [{ back }] } = await asAnon('select public.add_member($1, $2) back', [t, 'c']);
  assert.equal(back, c, '同名退出成员被恢复，而不是新建');
  assert.equal((await get()).members.length, 3);
  for (let i = 0; i < 17; i++) await asAnon('select public.add_member($1, $2)', [t, `x${i}`]);
  await rejects(asAnon('select public.add_member($1, $2)', [t, 'over']), /最多 20 位/);
  await rejects(asAnon('select public.add_member($1, $2)', [t, E_RTL]), /不支持的字符/);
  assert.ok(ids.length === 2);
});
const E_RTL = '\u202Eevil';

test('成员：改名与重名校验（含已退出成员）', async () => {
  const { t, ids, get } = await ledgerWith(['a', 'b', 'c'], '30.0.0.2');
  await asAnon('select public.rename_member($1, $2, $3)', [t, ids[0], '阿明']);
  assert.equal((await get()).members[0].name, '阿明');
  await rejects(asAnon('select public.rename_member($1, $2, $3)', [t, ids[0], 'b']), /同名/);
  await asAnon('select public.leave_member($1, $2)', [t, ids[2]]);
  await rejects(asAnon('select public.rename_member($1, $2, $3)', [t, ids[0], 'c']), /同名/);
  await asAnon('select public.rename_member($1, $2, $3)', [t, ids[0], '阿明']); // 改成自己原名不报错
  await rejects(asAnon('select public.rename_member($1, $2, $3)', [t, ids[0], '']), /成员名字需要/);
});

test('成员：退出至少保留 2 人、不能重复退出', async () => {
  const { t, ids } = await ledgerWith(['a', 'b', 'c'], '30.0.0.3');
  await asAnon('select public.leave_member($1, $2)', [t, ids[2]]);
  await rejects(asAnon('select public.leave_member($1, $2)', [t, ids[2]]), /已退出/);
  await rejects(asAnon('select public.leave_member($1, $2)', [t, ids[1]]), /至少需要 2 位/);
});

test('成员接口跨账本隔离', async () => {
  const A = await ledgerWith(['a', 'b', 'c'], '30.0.0.4');
  const B = await ledgerWith(['x', 'y', 'z'], '30.0.0.4');
  await rejects(asAnon('select public.rename_member($1, $2, $3)', [B.t, A.ids[0], 'hack']), /成员不存在/);
  await rejects(asAnon('select public.leave_member($1, $2)', [B.t, A.ids[0]]), /成员不存在/);
  await rejects(asAnon('select public.add_member($1, $2)', ['0'.repeat(32), 'x']), /不存在/);
  assert.equal((await A.get()).members[0].name, 'a');
});

test('退出成员：不能参与新支出，但可以还款；历史记录保留', async () => {
  const { t, ids, get, addE } = await ledgerWith(['a', 'b', 'c'], '30.0.0.5');
  await addE(ids[0], ids);
  await asAnon('select public.leave_member($1, $2)', [t, ids[2]]);
  await rejects(addE(ids[0], ids), /已退出/);
  await rejects(addE(ids[2], [ids[0], ids[1]]), /已退出/);
  await addE(ids[2], [ids[0]], 'transfer', 100); // 退出成员还清欠款
  await addE(ids[0], [ids[2]], 'transfer', 1);   // 也可以作为收款人
  const l = await get();
  assert.equal(l.entries.length, 3);
  assert.equal(l.members.length, 3);
});

test('编辑支出：字段更新并记录 updated_at；还款不能编辑；跨账本拒绝', async () => {
  const { t, ids, get, addE } = await ledgerWith(['a', 'b', 'c'], '30.0.0.6');
  const e = await addE(ids[0], ids);
  const tr = await addE(ids[1], [ids[0]], 'transfer', 100);
  const upd = (entry, amt, payer, parts, mode = 'equal', shares = null, tok = t) =>
    asAnon(`select public.update_entry($1,$2,'改过',$3,$4,$5::uuid[],current_date,$6,$7::bigint[])`, [tok, entry, amt, payer, parts, mode, shares]);
  await upd(e, 1000, ids[1], [ids[0], ids[1]], 'amount', [300, 700]);
  const x = (await get()).entries.find((y) => y.id === e);
  assert.equal(x.title, '改过');
  assert.equal(x.amount, 1000);
  assert.equal(x.payerId, ids[1]);
  assert.deepEqual(x.shares, [300, 700]);
  assert.ok(x.updatedAt);
  assert.equal((await get()).entries.find((y) => y.id === tr).updatedAt, null);
  await rejects(upd(tr, 100, ids[1], [ids[0]]), /还款记录不能编辑/);
  await rejects(upd(e, 1000, ids[1], [ids[0], ids[1]], 'amount', [300, 600]), /之和/);
  await rejects(upd('00000000-0000-0000-0000-000000000000', 100, ids[0], ids), /记录不存在/);
  const B = await ledgerWith(['x', 'y'], '30.0.0.6');
  await rejects(upd(e, 100, ids[0], ids, 'equal', null, B.t), /记录不存在/);
});

test('编辑支出：原记录里的退出成员可以保留，不能新加入其他退出成员', async () => {
  const { t, ids, addE } = await ledgerWith(['a', 'b', 'c', 'd'], '30.0.0.7');
  const e = await addE(ids[0], [ids[0], ids[2]]);
  await asAnon('select public.leave_member($1, $2)', [t, ids[2]]);
  await asAnon('select public.leave_member($1, $2)', [t, ids[3]]);
  const upd = (parts, payer = ids[0]) =>
    asAnon(`select public.update_entry($1,$2,'t',500,$3,$4::uuid[],current_date)`, [t, e, payer, parts]);
  await upd([ids[0], ids[2]]);
  await upd([ids[2]], ids[2]);
  await rejects(upd([ids[0], ids[3]]), /已退出/);
});

// ---------- #14 软删除与操作日志 ----------
const history = async (t) => (await asAnon('select public.get_history($1) h', [t])).rows[0].h;

test('删除进回收站：账本里消失、历史里可见、可恢复且不能重复恢复', async () => {
  const { t, ids, get, addE } = await ledgerWith(['a', 'b'], '40.0.0.1');
  const e = await addE(ids[0], ids);
  await asAnon('select public.delete_entry($1,$2)', [t, e]);
  assert.equal((await get()).entries.length, 0);
  await rejects(asAnon('select public.delete_entry($1,$2)', [t, e]), /记录不存在/);
  const h = await history(t);
  assert.equal(h.deleted.length, 1);
  assert.equal(h.deleted[0].id, e);
  assert.ok(h.deleted[0].deletedAt);
  await asAnon('select public.restore_entry($1,$2)', [t, e]);
  assert.equal((await get()).entries.length, 1);
  assert.equal((await history(t)).deleted.length, 0);
  await rejects(asAnon('select public.restore_entry($1,$2)', [t, e]), /已恢复/);
});

test('已删除的记录不能编辑；恢复涉及退出成员的记录也可以', async () => {
  const { t, ids, addE } = await ledgerWith(['a', 'b', 'c'], '40.0.0.2');
  const e = await addE(ids[2], ids);
  await asAnon('select public.delete_entry($1,$2)', [t, e]);
  await rejects(asAnon(`select public.update_entry($1,$2,'x',100,$3,$4::uuid[],current_date)`, [t, e, ids[0], ids]), /记录不存在/);
  await asAnon('select public.leave_member($1,$2)', [t, ids[2]]);
  await asAnon('select public.restore_entry($1,$2)', [t, e]);
});

test('回收站与日志跨账本隔离；anon 不能读日志表、不能调 _log', async () => {
  const A = await ledgerWith(['a', 'b'], '40.0.0.3');
  const B = await ledgerWith(['x', 'y'], '40.0.0.3');
  const e = await A.addE(A.ids[0], A.ids);
  await asAnon('select public.delete_entry($1,$2)', [A.t, e]);
  await rejects(asAnon('select public.restore_entry($1,$2)', [B.t, e]), /记录不存在/);
  const hb = await history(B.t);
  assert.equal(hb.deleted.length, 0);
  assert.ok(hb.activities.every((x) => x.action === 'create'));
  await rejects(asAnon('select * from public.activities'), /permission denied/);
  await rejects(asAnon(`select public._log(gen_random_uuid(), 'x', '{}')`), /permission denied/);
});

test('操作日志：记录所有写操作，最新在前，含新旧值', async () => {
  const { t, ids, addE } = await ledgerWith(['a', 'b', 'c'], '40.0.0.4');
  const e = await addE(ids[0], ids);
  await asAnon(`select public.update_entry($1,$2,'改',500,$3,$4::uuid[],current_date)`, [t, e, ids[0], ids]);
  await asAnon('select public.delete_entry($1,$2)', [t, e]);
  await asAnon('select public.restore_entry($1,$2)', [t, e]);
  await asAnon(`select public.add_member($1,'d')`, [t]);
  await asAnon(`select public.rename_member($1,$2,'A')`, [t, ids[0]]);
  await asAnon('select public.leave_member($1,$2)', [t, ids[2]]);
  await asAnon(`select public.add_member($1,'c')`, [t]);
  const acts = (await history(t)).activities;
  assert.deepEqual(acts.map((x) => x.action), ['restore_member', 'leave_member', 'rename_member', 'add_member',
    'restore_entry', 'delete_entry', 'update_entry', 'add_entry', 'create']);
  assert.deepEqual(acts.find((x) => x.action === 'update_entry').detail, { title: '改', amount: 500, oldTitle: 't', oldAmount: 300 });
  assert.deepEqual(acts.find((x) => x.action === 'rename_member').detail, { name: 'A', oldName: 'a' });
  assert.deepEqual(acts.at(-1).detail, { name: 'm', members: ['a', 'b', 'c'] });
});

test('上限：回收站最多 100 条、超过 30 天自动清理；日志最多 500 条；删除的记录不占 2000 条额度', async () => {
  const { t, ids, get, addE } = await ledgerWith(['a', 'b'], '40.0.0.5');
  const lid = (await db.query(`select ledger_id l from public.members where id = $1`, [ids[0]])).rows[0].l;
  // 直接造数据：100 条近期删除 + 1 条 40 天前删除，再删一条（共 102 条）触发清理
  await db.query(`insert into public.entries (ledger_id, kind, title, amount, payer_id, participant_ids, deleted_at)
    select $1, 'expense', 'old' || g, 100, $2, $3::uuid[], now() - (g || ' minutes')::interval from generate_series(1, 100) g`, [lid, ids[0], ids]);
  await db.query(`insert into public.entries (ledger_id, kind, title, amount, payer_id, participant_ids, deleted_at)
    values ($1, 'expense', 'ancient', 100, $2, $3::uuid[], now() - interval '40 days')`, [lid, ids[0], ids]);
  const e = await addE(ids[0], ids);
  await asAnon('select public.delete_entry($1,$2)', [t, e]);
  const n = (await db.query(`select count(*)::int n, bool_or(title = 'ancient') o, bool_or(title = 'old99') keep, bool_or(title = 'old100') last from public.entries where ledger_id = $1 and deleted_at is not null`, [lid])).rows[0];
  assert.equal(n.n, 100);
  assert.equal(n.o, false, '30 天前删除的已清理');
  assert.equal(n.last, false, '超出 100 条时清掉最早删除的');
  assert.equal(n.keep, true);
  assert.equal((await history(t)).deleted.length, 100);
  await db.query(`insert into public.activities (ledger_id, action) select $1, 'x' from generate_series(1, 600)`, [lid]);
  await addE(ids[0], ids);
  assert.equal((await db.query('select count(*)::int n from public.activities where ledger_id = $1', [lid])).rows[0].n, 500);
  assert.equal((await history(t)).activities.length, 100);
  assert.equal((await history(t)).activities[0].action, 'add_entry');
  // 1999 条在账 + 100 条在回收站：还能再记 1 条
  await db.query(`insert into public.entries (ledger_id, kind, title, amount, payer_id, participant_ids)
    select $1, 'expense', 'live', 100, $2, $3::uuid[] from generate_series(1, 1998) g`, [lid, ids[0], ids]);
  assert.equal((await get()).entries.length, 1999);
  await addE(ids[0], ids);
  await rejects(addE(ids[0], ids), /2000/);
  const del = (await history(t)).deleted[0].id;
  await rejects(asAnon('select public.restore_entry($1,$2)', [t, del]), /2000/);
});

// ---------- #12 周期账单 ----------
const q1 = async (sql, params) => (await db.query(sql, params)).rows[0];

test('_next_month_day：月底顺延，且不会"漂移"到 28 号', async () => {
  const seq = [];
  let d = '2026-01-31';
  for (let i = 0; i < 4; i++) { d = (await q1(`select public._next_month_day($1::date, 31)::text d`, [d])).d; seq.push(d); }
  assert.deepEqual(seq, ['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
  assert.equal((await q1(`select public._next_month_day('2027-12-15', 15)::text d`)).d, '2028-01-15');
  assert.equal((await q1(`select public._next_month_day('2028-01-29', 29)::text d`)).d, '2028-02-29', '闰年');
});

test('周期账单：新建时补记过去的期数，按月推进，重复打开不会重复记', async () => {
  const { t, ids, get } = await ledgerWith(['a', 'b'], '50.0.0.1');
  const today = (await q1(`select public._bj_today()::text d`)).d;
  const start = (await q1(`select (public._bj_today() - interval '2 months')::date::text d`)).d;
  const r = (await asAnon(`select public.add_recurring($1,'房租',300000,$2,$3::uuid[],$4::date) r`, [t, ids[0], ids, start])).rows[0].r;
  assert.ok(r.id);
  assert.equal(r.added, 3, '两个月前开始：补记 3 期（含本月）');
  for (let i = 0; i < 2; i++) assert.equal((await asAnon('select public.run_recurring($1) n', [t])).rows[0].n, 0);
  const l = await get();
  assert.equal(l.entries.length, 3);
  assert.ok(l.entries.every((e) => e.recurringId === r.id && e.title === '房租' && e.amount === 300000));
  assert.ok(l.entries.every((e) => e.spentOn <= today), '不会记未来的账');
  assert.equal(l.entries.at(-1).spentOn, start, '第一期在首次日期');
  assert.equal(l.recurring.length, 1);
  assert.ok(l.recurring[0].nextOn > today, '下一次在今天之后');
  assert.equal(l.today, today);
});

test('周期账单：首次日期在未来时不记账，到期后 run_recurring 补记', async () => {
  const { t, ids, get } = await ledgerWith(['a', 'b'], '50.0.0.2');
  const start = (await q1(`select (public._bj_today() + 3)::text d`)).d;
  const r = (await asAnon(`select public.add_recurring($1,'网费',10000,$2,$3::uuid[],$4::date,'ratio',array[2,1]::bigint[]) r`, [t, ids[1], ids, start])).rows[0].r;
  assert.equal(r.added, 0);
  assert.equal((await get()).entries.length, 0);
  await db.query(`update public.recurring set next_on = next_on - 3 where id = $1`, [r.id]); // 模拟时间流逝
  assert.equal((await asAnon('select public.run_recurring($1) n', [t])).rows[0].n, 1);
  const e = (await get()).entries[0];
  assert.equal(e.splitMode, 'ratio');
  assert.deepEqual(e.shares, [2, 1]);
});

test('周期账单：校验、上限、跨账本隔离、退出成员、删除后流水保留', async () => {
  const { t, ids, get } = await ledgerWith(['a', 'b', 'c'], '50.0.0.3');
  const add = (o = {}) => asAnon(`select public.add_recurring($1,$2,$3,$4,$5::uuid[],$6::date,$7,$8::bigint[]) r`,
    [o.t ?? t, o.title ?? 'x', o.amount ?? 100, o.payer ?? ids[0], o.parts ?? ids, o.start ?? '2099-01-01', o.mode ?? 'equal', o.shares ?? null]);
  await rejects(add({ start: '2099-01-01' }), /前后一年/);
  const far = (await q1(`select (public._bj_today() - 400)::text d`)).d;
  await rejects(add({ start: far }), /前后一年/);
  const ok = (await q1(`select (public._bj_today() + 1)::text d`)).d;
  await rejects(add({ start: ok, amount: 0 }), /金额/);
  await rejects(add({ start: ok, mode: 'amount', shares: [1, 2, 3] }), /之和/);
  await rejects(add({ start: ok, title: ' ' }), /内容/);
  const B = await ledgerWith(['x', 'y'], '50.0.0.3');
  await rejects(add({ start: ok, payer: B.ids[0] }), /不属于/);
  const r = (await add({ start: ok, parts: [ids[0], ids[2]] })).rows[0].r;
  await rejects(asAnon('select public.delete_recurring($1,$2)', [B.t, r.id]), /不存在/);
  await rejects(asAnon('select public.leave_member($1,$2)', [t, ids[2]]), /周期账单/);
  await asAnon('select public.leave_member($1,$2)', [t, ids[1]]); // 不在周期账单里的人可以退出
  await rejects(add({ start: ok, parts: [ids[0], ids[1]] }), /已退出/);
  // 生成一笔流水后删除周期账单：流水保留，关联断开
  await db.query(`update public.recurring set next_on = public._bj_today() where id = $1`, [r.id]);
  await asAnon('select public.run_recurring($1)', [t]);
  await asAnon('select public.delete_recurring($1,$2)', [t, r.id]);
  const l = await get();
  assert.equal(l.recurring.length, 0);
  assert.equal(l.entries.length, 1);
  assert.equal(l.entries[0].recurringId, null);
  await asAnon(`select public.add_member($1,'d')`, [t]);
  await asAnon('select public.leave_member($1,$2)', [t, ids[2]]); // 周期账单删掉后，c 可以退出了
  for (let i = 0; i < 20; i++) await add({ start: ok, parts: [ids[0]] });
  await rejects(add({ start: ok, parts: [ids[0]] }), /最多 20 个/);
  const acts = (await history(t)).activities.map((x) => x.action);
  assert.ok(acts.includes('add_recurring') && acts.includes('delete_recurring'));
});

test('周期账单：账本满 2000 条时暂停补记，腾出空间后继续；anon 不能读 recurring 表、不能调内部函数', async () => {
  const { t, ids, get } = await ledgerWith(['a', 'b'], '50.0.0.4');
  const lid = (await q1(`select ledger_id l from public.members where id = $1`, [ids[0]])).l;
  await db.query(`insert into public.entries (ledger_id, kind, title, amount, payer_id, participant_ids)
    select $1, 'expense', 'live', 100, $2, $3::uuid[] from generate_series(1, 1999)`, [lid, ids[0], ids]);
  const start = (await q1(`select (public._bj_today() - interval '2 months')::date::text d`)).d;
  const r = (await asAnon(`select public.add_recurring($1,'x',100,$2,$3::uuid[],$4::date) r`, [t, ids[0], ids, start])).rows[0].r;
  assert.equal(r.added, 1, '只记到 2000 条为止');
  assert.equal((await asAnon('select public.run_recurring($1) n', [t])).rows[0].n, 0);
  await db.query(`delete from public.entries where ledger_id = $1 and title = 'live' and id in (select id from public.entries where ledger_id = $1 and title = 'live' limit 5)`, [lid]);
  assert.equal((await asAnon('select public.run_recurring($1) n', [t])).rows[0].n, 2, '腾出空间后补齐剩下的期数');
  assert.equal((await get()).entries.length, 1997);
  await rejects(asAnon('select * from public.recurring'), /permission denied/);
  await rejects(asAnon(`select public._run_recurring(gen_random_uuid())`), /permission denied/);
  await rejects(asAnon(`select public._bj_today()`), /permission denied/);
});

// ---------- #13 多币种 ----------
test('多币种：服务端按原币 × 汇率折算人民币，编辑可改币种，校验与日志', async () => {
  const { t, ids, get } = await ledgerWith(['a', 'b', 'c'], '60.0.0.1');
  const addFx = (orig, cur, rate, mode = 'equal', shares = null, kind = 'expense', parts = ids) =>
    asAnon(`select public.add_entry($1,$2,'寿司',999,$3,$4::uuid[],current_date,$5,$6::bigint[],$7,$8,$9) e`,
      [t, kind, ids[0], parts, mode, shares, cur, orig, rate]).then((r) => r.rows[0].e);
  // 3,000 日元，汇率 0.048123 → 144.369 元 → 14437 分（忽略前端传来的 999）
  const e = await addFx(300000, 'JPY', 48123);
  let l = await get();
  let x = l.entries.find((y) => y.id === e);
  assert.deepEqual([x.amount, x.currency, x.origAmount, x.fxRate], [14437, 'JPY', 300000, 48123]);
  await addFx(1000, 'USD', 7123456, 'ratio', [2, 1, 1]); // 10 美元 → 71.23456 → 7123 分
  l = await get();
  assert.equal(l.entries.find((y) => y.currency === 'USD').amount, 7123);
  // 校验
  await rejects(addFx(100, 'CNY', 1000000), /币种不合法/);
  await rejects(addFx(100, 'usd', 1000000), /币种不合法/);
  await rejects(addFx(0, 'USD', 1000000), /外币金额/);
  await rejects(addFx(100, 'USD', 0), /汇率/);
  await rejects(addFx(100, 'USD', 1000000001), /汇率/);
  await rejects(addFx(100, 'USD', null), /汇率/);
  await rejects(addFx(1000, 'USD', 1000000, 'amount', [5, 5]), /均摊或按比例/);
  await rejects(addFx(100, 'USD', 1000000, 'equal', null, 'transfer', [ids[1]]), /还款只支持人民币/);
  await rejects(addFx(1000000000000, 'USD', 1000000000), /金额需大于 0 且不超过 1000 万/); // 折合后超上限
  // 折合后不足 1 分
  await rejects(addFx(1, 'IDR', 1), /金额需大于 0/);
  // 编辑：改汇率，再改回人民币
  await asAnon(`select public.update_entry($1,$2,'寿司',1,$3,$4::uuid[],current_date,'equal',null,'JPY',300000,50000)`, [t, e, ids[0], ids]);
  x = (await get()).entries.find((y) => y.id === e);
  assert.equal(x.amount, 15000);
  await asAnon(`select public.update_entry($1,$2,'寿司',12000,$3,$4::uuid[],current_date)`, [t, e, ids[0], ids]);
  x = (await get()).entries.find((y) => y.id === e);
  assert.deepEqual([x.amount, x.currency, x.origAmount, x.fxRate], [12000, null, null, null]);
  // 日志记录原币；回收站返回原币
  const acts = (await history(t)).activities;
  assert.deepEqual(acts.find((a) => a.detail.currency === 'USD').detail, { kind: 'expense', title: '寿司', amount: 7123, currency: 'USD', origAmount: 1000 });
  const usd = (await get()).entries.find((y) => y.currency === 'USD');
  await asAnon('select public.delete_entry($1,$2)', [t, usd.id]);
  const del = (await history(t)).deleted[0];
  assert.deepEqual([del.currency, del.origAmount], ['USD', 1000]);
  // 旧前端：9 参数调用仍可用；内部函数 anon 不可调
  await asAnon(`select public.add_entry($1,'expense','旧',100,$2,$3::uuid[],current_date,'equal',null)`, [t, ids[0], ids]);
  await rejects(asAnon(`select public._fx_amount('expense',1,'USD',1,1,'equal')`), /permission denied/);
  const { rows } = await db.query(`select count(*)::int n from pg_proc where proname in ('add_entry','update_entry')`);
  assert.equal(rows[0].n, 2, '没有残留的旧重载');
});
