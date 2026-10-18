import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, formatCents, splitEqual, computeBalances, minimizeTransfers, validateMembers } from '../site/js/settle.js';

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
