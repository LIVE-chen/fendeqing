// 统计与 xlsx 导出的单元测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 as zcrc } from 'node:zlib';
import { monthlyTotals, memberStats, barPercents, ledgerSheets, exportFileName } from '../site/js/stats.js';
import { crc32, zipStore, buildXlsx } from '../site/js/xlsx.js';

const M = [{ id: 'a', name: '我' }, { id: 'b', name: '小王' }, { id: 'c', name: '小李', left: true }];
const E = [
  { kind: 'expense', title: '房租', amount: 300000, payerId: 'a', participantIds: ['a', 'b', 'c'], spentOn: '2026-09-01', createdAt: '1' },
  { kind: 'expense', title: '电费', amount: 100, payerId: 'b', participantIds: ['a', 'b'], spentOn: '2026-10-02', createdAt: '2', splitMode: 'ratio', shares: [3, 1] },
  { kind: 'transfer', title: '结算转账', amount: 5000, payerId: 'b', participantIds: ['a'], spentOn: '2026-10-03', createdAt: '3' },
  { kind: 'expense', title: '=HYPERLINK("http://x")<&>', amount: 1, payerId: 'a', participantIds: ['a'], spentOn: '2026-10-05', createdAt: '4', updatedAt: 'x' },
];

test('monthlyTotals：只算支出，按月倒序', () => {
  assert.deepEqual(monthlyTotals(E), [{ month: '2026-10', total: 101, count: 2 }, { month: '2026-09', total: 300000, count: 1 }]);
  assert.deepEqual(monthlyTotals([]), []);
});

test('memberStats：垫付与实际消费，消费合计等于支出总额，退出成员有数据时保留', () => {
  const s = memberStats(M, E);
  assert.deepEqual(s.map((x) => [x.id, x.paid, x.share]), [['a', 300001, 100000 + 75 + 1], ['b', 100, 100000 + 25], ['c', 0, 100000]]);
  assert.equal(s.reduce((t, x) => t + x.share, 0), 300101);
  assert.deepEqual(memberStats(M, []).map((x) => x.id), ['a', 'b'], '退出且无数据的成员不显示');
});

test('barPercents', () => {
  assert.deepEqual(barPercents([100, 50, 1, 0]), [100, 50, 2, 0]);
  assert.deepEqual(barPercents([0, 0]), [0, 0]);
  assert.deepEqual(barPercents([]), []);
});

test('crc32 与 zlib 一致', () => {
  for (const s of ['', 'a', '分得清', 'x'.repeat(10000)]) {
    const b = new TextEncoder().encode(s);
    assert.equal(crc32(b), zcrc(b));
  }
});

// 独立实现的最小 ZIP 读取器：按中央目录取出每个文件，校验 CRC
function unzip(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const endAt = buf.length - 22;
  assert.equal(v.getUint32(endAt, true), 0x06054b50);
  const n = v.getUint16(endAt + 10, true);
  let p = v.getUint32(endAt + 16, true);
  const files = {};
  for (let i = 0; i < n; i++) {
    assert.equal(v.getUint32(p, true), 0x02014b50);
    const crc = v.getUint32(p + 16, true);
    const size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const off = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
    assert.equal(v.getUint32(off, true), 0x04034b50);
    const start = off + 30 + v.getUint16(off + 26, true) + v.getUint16(off + 28, true);
    const data = buf.subarray(start, start + size);
    assert.equal(zcrc(data), crc, `${name} CRC`);
    files[name] = new TextDecoder().decode(data);
    p += 46 + nameLen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
  }
  return files;
}

test('zipStore：可被独立读取器解析，CRC 正确，UTF-8 文件名', () => {
  const f = unzip(zipStore([{ name: 'a.txt', data: new TextEncoder().encode('hi') }, { name: '中文.xml', data: new Uint8Array() }]));
  assert.deepEqual(f, { 'a.txt': 'hi', '中文.xml': '' });
});

test('buildXlsx：结构完整、文本转义、公式不会被执行、金额为数字', () => {
  const files = unzip(buildXlsx(ledgerSheets({ members: M, entries: E }), new Date(2026, 9, 20)));
  assert.deepEqual(Object.keys(files).sort(), ['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml',
    'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'xl/worksheets/sheet3.xml', 'xl/worksheets/sheet4.xml']);
  assert.match(files['xl/workbook.xml'], /name="流水".*name="每人余额".*name="结算方案".*name="按月统计"/);
  const s1 = files['xl/worksheets/sheet1.xml'];
  assert.ok(!s1.includes('<f>'), '没有公式单元格');
  assert.ok(s1.includes('t="inlineStr"><is><t xml:space="preserve">=HYPERLINK(&quot;http://x&quot;)&lt;&amp;&gt;</t>'), '以文本写入并转义');
  assert.ok(s1.includes('<c r="D2" s="2"><v>3000.00</v></c>'), '金额是数字单元格（元，两位小数）');
  assert.ok(s1.includes('小李（已退出） 1000.00'), '分摊明细');
  assert.ok(s1.includes('按比例'));
  assert.ok(s1.includes('还给 我'));
  assert.ok(files['xl/worksheets/sheet2.xml'].includes('<v>-1000.00</v>'), '余额可为负数');
  // 每个 XML 都能被解析：标签成对（粗略检查 <row> 与 </row> 数量一致）
  for (const [k, x] of Object.entries(files)) {
    assert.ok(x.startsWith('<?xml'), k);
    assert.equal((x.match(/<row /g) ?? []).length, (x.match(/<\/row>/g) ?? []).length, k);
  }
});

test('ledgerSheets：流水按日期正序，余额表合计为 0，结算方案与按月统计', () => {
  const [flow, bal, plan, monthly] = ledgerSheets({ members: M, entries: E });
  assert.deepEqual(flow.rows.slice(1).map((r) => r[0]), ['2026-09-01', '2026-10-02', '2026-10-03', '2026-10-05']);
  assert.equal(bal.rows.slice(1).reduce((t, r) => t + r[3].money, 0), 0);
  assert.ok(plan.rows.length >= 2);
  assert.deepEqual(monthly.rows[1], ['2026-10', 2, { money: 101 }]);
  // 去掉控制字符：XML 1.0 不允许
  const x = buildXlsx([{ name: 'x', rows: [['a\u0001b\u000bc']] }]);
  assert.ok(unzip(x)['xl/worksheets/sheet1.xml'].includes('>abc<'));
});

test('exportFileName 去掉非法字符', () => {
  assert.equal(exportFileName('502/合租:<A>', '2026-10-20'), '502_合租__A_-2026-10-20.xlsx');
  assert.equal(exportFileName('', '2026-10-20'), '账本-2026-10-20.xlsx');
});
