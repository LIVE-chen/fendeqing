import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, formatCents, splitEqual, splitByWeights, entryShares, parseSplit, computeBalances, minimizeTransfers, validateMembers, centsToInput, canLeave, validateMemberName } from '../site/js/settle.js';

test('parseAmount 接受合法金额', () => {
  assert.equal(parseAmount('12'), 1200);
  assert.equal(parseAmount('12.5'), 1250);
  assert.equal(parseAmount(' ￥0.01 '), 1);
  assert.equal(parseAmount('1,234.56'), 123456);
});

test('parseAmount 拒绝非法金额', () => {
  for (const bad of ['', '0', '-1', 'abc', '1.234', '1e5', '10000000.01', '.5', null, undefined, {}]) {
    assert.equal(parseAmount(bad), null, `应拒绝 ${String(bad)}`);
  }
});

test('formatCents', () => {
  assert.equal(formatCents(123456), '¥1,234.56');
  assert.equal(formatCents(-5), '-¥0.05');
});

test('splitEqual 总和不变、差额不超过 1 分', () => {
  const parts = splitEqual(1000, 3);
  assert.deepEqual(parts, [334, 333, 333]);
  assert.equal(parts.reduce((a, b) => a + b, 0), 1000);
});

const members = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

test('余额之和恒为 0', () => {
  const bal = computeBalances(members, [
    { payerId: 'a', amount: 1000, participantIds: ['a', 'b', 'c'] },
    { payerId: 'b', amount: 333, participantIds: ['a', 'c'] },
  ]);
  const sum = [...bal.values()].reduce((x, y) => x + y, 0);
  assert.equal(sum, 0);
});

test('还款记录可以抵消欠款', () => {
  const entries = [{ payerId: 'a', amount: 900, participantIds: ['a', 'b', 'c'] }];
  let t = minimizeTransfers(computeBalances(members, entries));
  assert.deepEqual(t.map((x) => [x.from, x.to, x.amount]).sort(), [['b', 'a', 300], ['c', 'a', 300]]);
  entries.push({ payerId: 'b', amount: 300, participantIds: ['a'] });
  entries.push({ payerId: 'c', amount: 300, participantIds: ['a'] });
  t = minimizeTransfers(computeBalances(members, entries));
  assert.equal(t.length, 0);
});

test('转账笔数不超过 n-1，且执行后全部结清', () => {
  const ms = Array.from({ length: 8 }, (_, i) => ({ id: `m${i}` }));
  const entries = [];
  let seed = 42;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
  for (let k = 0; k < 60; k++) {
    const parts = ms.filter(() => rnd(2)).map((m) => m.id);
    entries.push({ payerId: ms[rnd(8)].id, amount: 1 + rnd(50000), participantIds: parts.length ? parts : ['m0'] });
  }
  const bal = computeBalances(ms, entries);
  const t = minimizeTransfers(bal);
  assert.ok(t.length <= ms.length - 1);
  for (const x of t) { bal.set(x.from, bal.get(x.from) + x.amount); bal.set(x.to, bal.get(x.to) - x.amount); }
  assert.ok([...bal.values()].every((v) => v === 0));
});

test('忽略不属于账本的成员', () => {
  const bal = computeBalances(members, [{ payerId: 'x', amount: 100, participantIds: ['a'] }]);
  assert.ok([...bal.values()].every((v) => v === 0));
});

test('validateMembers', () => {
  assert.equal(validateMembers(['我']).ok, false);
  assert.equal(validateMembers(['a', 'a']).ok, false);
  assert.equal(validateMembers(['a', 'x'.repeat(21)]).ok, false);
  assert.deepEqual(validateMembers([' 我 ', '', '小王']), { ok: true, names: ['我', '小王'] });
});

// ---------- #9 按比例 / 按金额分摊 ----------
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

test('splitByWeights：权重全为 1 时与 splitEqual 一致', () => {
  for (const [amt, n] of [[1000, 3], [1, 4], [99999, 7], [5, 5]]) {
    assert.deepEqual(splitByWeights(amt, Array(n).fill(1)), splitEqual(amt, n));
  }
});

test('splitByWeights：按比例，总和守恒，最大余数法', () => {
  assert.deepEqual(splitByWeights(10000, [2, 1]), [6667, 3333]);
  assert.deepEqual(splitByWeights(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(splitByWeights(1000, [1, 2, 3, 4]), [100, 200, 300, 400]);
  // 余数大的人优先补 1 分：10 × [1,1,3]/5 = [2,2,6] 整除；7 × [1,1,3]/5 = [1.4,1.4,4.2] → [2,1,4]
  assert.deepEqual(splitByWeights(7, [1, 1, 3]), [2, 1, 4]);
});

test('splitByWeights：按金额时恰好还原每人金额，且大数不丢精度', () => {
  assert.deepEqual(splitByWeights(10000, [3000, 7000]), [3000, 7000]);
  const big = [999_999_999, 1];
  assert.deepEqual(splitByWeights(1_000_000_000, big), big);
});

test('splitByWeights：随机数据总和恒等于金额，每人与理论值相差 < 1 分', () => {
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
  for (let k = 0; k < 500; k++) {
    const w = Array.from({ length: 1 + rnd(20) }, () => 1 + rnd(1000));
    const amt = 1 + rnd(1_000_000_000);
    const r = splitByWeights(amt, w);
    assert.equal(sum(r), amt);
    const W = sum(w);
    r.forEach((c, i) => assert.ok(Math.abs(c - (amt * w[i]) / W) < 1));
  }
});

test('computeBalances 支持按比例 / 按金额，余额之和为 0', () => {
  const bal = computeBalances(members, [
    { payerId: 'a', amount: 9000, participantIds: ['b', 'c'], splitMode: 'ratio', shares: [2, 1] },
    { payerId: 'b', amount: 1000, participantIds: ['a', 'c'], splitMode: 'amount', shares: [100, 900] },
  ]);
  assert.deepEqual([...bal], [['a', 9000 - 100], ['b', 1000 - 6000], ['c', -3000 - 900]]);
  assert.equal(sum([...bal.values()]), 0);
});

test('entryShares：参与人顺序与成员顺序不同时，份额跟着人走', () => {
  const e = { amount: 400, participantIds: ['c', 'a'], splitMode: 'amount', shares: [300, 100] };
  assert.deepEqual(entryShares(members, e), [['a', 100], ['c', 300]]);
});

test('entryShares：份额数据缺失或长度不符时退回均摊', () => {
  assert.deepEqual(entryShares(members, { amount: 100, participantIds: ['a', 'b'], splitMode: 'ratio', shares: [1] }), [['a', 50], ['b', 50]]);
  assert.deepEqual(entryShares(members, { amount: 100, participantIds: ['a', 'b'] }), [['a', 50], ['b', 50]]);
});

test('entryShares：有参与人已不在账本时，剩下的人按原权重分摊全额', () => {
  const r = entryShares(members, { amount: 900, participantIds: ['a', 'gone', 'b'], splitMode: 'ratio', shares: [1, 5, 2] });
  assert.deepEqual(r, [['a', 300], ['b', 600]]);
});

test('parseSplit', () => {
  assert.deepEqual(parseSplit('equal', 100, []), { ok: true, shares: null });
  assert.deepEqual(parseSplit('ratio', 100, ['2', ' 1 ']), { ok: true, shares: [2, 1] });
  for (const bad of [['0'], ['1.5'], ['1001'], [''], ['abc']]) assert.equal(parseSplit('ratio', 100, bad).ok, false, bad[0]);
  assert.deepEqual(parseSplit('amount', 10000, ['30', '70']), { ok: true, shares: [3000, 7000] });
  assert.match(parseSplit('amount', 10000, ['30', '60']).error, /还差 ¥10\.00/);
  assert.match(parseSplit('amount', 10000, ['50', '60']).error, /多了 ¥10\.00/);
  assert.equal(parseSplit('amount', 10000, ['100', '0']).ok, false);
  assert.equal(parseSplit('hack', 100, ['1']).ok, false);
});

test('centsToInput 与 parseAmount 互逆', () => {
  assert.equal(centsToInput(1250), '12.50');
  assert.equal(centsToInput(5), '0.05');
  assert.equal(centsToInput(123456789), '1234567.89'); // 不带千分位
  for (const c of [1, 99, 100, 10001, 1_000_000_000]) assert.equal(parseAmount(centsToInput(c)), c);
});

test('退出成员仍参与余额计算，历史记录不变', () => {
  const members = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C', left: true }];
  const bal = computeBalances(members, [{ payerId: 'c', amount: 300, participantIds: ['a', 'b', 'c'] }]);
  assert.deepEqual([...bal], [['a', -100], ['b', -100], ['c', 200]]);
  const tr = minimizeTransfers(bal);
  assert.ok(tr.every((t) => t.to === 'c'));
});

test('canLeave：需在账、退出后不少于 2 人、余额为 0', () => {
  const m = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }, { id: 'd', name: 'D', left: true }];
  const zero = new Map(m.map((x) => [x.id, 0]));
  assert.equal(canLeave(m, zero, 'a').ok, true);
  assert.match(canLeave(m, new Map([['a', 150]]), 'a').error, /A还有应收 ¥1\.50 未结清/);
  assert.match(canLeave(m, new Map([['a', -1]]), 'a').error, /应付 ¥0\.01/);
  assert.match(canLeave(m, zero, 'd').error, /已退出/);
  assert.match(canLeave(m, zero, 'x').error, /不存在/);
  assert.match(canLeave(m.filter((x) => x.id !== 'c'), zero, 'a').error, /至少需要 2 位/);
});

test('validateMemberName', () => {
  assert.deepEqual(validateMemberName('  小王 ', ['小李']), { ok: true, name: '小王' });
  assert.equal(validateMemberName('   ').ok, false);
  assert.equal(validateMemberName('x'.repeat(21)).ok, false);
  assert.equal(validateMemberName('小李', ['小李']).error, '已有同名成员');
});
