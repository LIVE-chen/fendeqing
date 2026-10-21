// 纯函数：统计（只算支出，不算还款）。金额单位为分。
import { entryShares, computeBalances, minimizeTransfers, formatForeign, rateToInput } from './settle.js';

/** 按月汇总支出：[{ month: '2026-10', total, count }]，按月份倒序 */
export function monthlyTotals(entries) {
  const map = new Map();
  for (const e of entries) {
    if (e.kind !== 'expense') continue;
    const m = String(e.spentOn).slice(0, 7);
    const x = map.get(m) ?? { month: m, total: 0, count: 0 };
    x.total += e.amount;
    x.count += 1;
    map.set(m, x);
  }
  return [...map.values()].sort((a, b) => b.month.localeCompare(a.month));
}

/**
 * 每人统计：paid = 垫付的支出合计，share = 应摊（实际消费）合计。
 * 按成员顺序返回；已退出成员只要有数据就保留。所有人 share 之和 = 支出总额。
 */
export function memberStats(members, entries) {
  const stat = new Map(members.map((m) => [m.id, { id: m.id, name: m.name, left: Boolean(m.left), paid: 0, share: 0 }]));
  for (const e of entries) {
    if (e.kind !== 'expense' || !stat.has(e.payerId)) continue;
    const shares = entryShares(members, e);
    if (shares.length === 0) continue;
    stat.get(e.payerId).paid += e.amount;
    for (const [id, c] of shares) stat.get(id).share += c;
  }
  return [...stat.values()].filter((s) => !s.left || s.paid || s.share);
}

/** 条形图宽度百分比：最大值为 100%，非零值至少 2% 以免看不见 */
export function barPercents(values) {
  const max = Math.max(0, ...values);
  return values.map((v) => (max <= 0 || v <= 0 ? 0 : Math.max(2, Math.round((v / max) * 100))));
}

const MODE_TEXT = { equal: '均摊', ratio: '按比例', amount: '按金额' };

/** 导出用的表格数据（纯数据，交给 xlsx.js 生成文件）。金额单元格用 { money: 分 } 表示 */
export function ledgerSheets({ members, entries }) {
  const nameOf = (id) => {
    const m = members.find((x) => x.id === id);
    return m ? m.name + (m.left ? '（已退出）' : '') : '已删除成员';
  };
  const flow = [['日期', '类型', '内容', '金额（元）', '付款人', '分摊方式', '分摊明细', '已编辑', '原币金额', '汇率']];
  for (const e of [...entries].sort((a, b) => a.spentOn.localeCompare(b.spentOn) || String(a.createdAt).localeCompare(String(b.createdAt)))) {
    const isT = e.kind === 'transfer';
    flow.push([
      e.spentOn, isT ? '还款' : '支出', e.title, { money: e.amount }, nameOf(e.payerId),
      isT ? '' : MODE_TEXT[e.splitMode] ?? '均摊',
      isT ? `还给 ${nameOf(e.participantIds[0])}`
        : entryShares(members, e).map(([id, c]) => `${nameOf(id)} ${(c / 100).toFixed(2)}`).join('，'),
      e.updatedAt ? '是' : '',
      // 外币支出另列原币与汇率（文本），金额列始终是折合后的人民币
      e.currency ? formatForeign(e.origAmount, e.currency) : '',
      e.currency ? rateToInput(e.fxRate) : '',
    ]);
  }
  const balances = computeBalances(members, entries);
  const bal = [['成员', '垫付支出（元）', '实际消费（元）', '余额（元）', '状态']];
  for (const s of memberStats(members, entries)) {
    const v = balances.get(s.id) ?? 0;
    if (s.left && !s.paid && !s.share && !v) continue;
    bal.push([s.name + (s.left ? '（已退出）' : ''), { money: s.paid }, { money: s.share }, { money: v },
      v > 0 ? '应收' : v < 0 ? '应付' : '已结清']);
  }
  const plan = [['付款人', '收款人', '金额（元）']];
  for (const t of minimizeTransfers(balances)) plan.push([nameOf(t.from), nameOf(t.to), { money: t.amount }]);
  const monthly = [['月份', '支出笔数', '支出合计（元）']];
  for (const m of monthlyTotals(entries)) monthly.push([m.month, m.count, { money: m.total }]);
  return [
    { name: '流水', rows: flow, widths: [12, 6, 24, 12, 12, 9, 40, 7, 18, 11] },
    { name: '每人余额', rows: bal, widths: [16, 15, 15, 12, 8] },
    { name: '结算方案', rows: plan, widths: [16, 16, 12] },
    { name: '按月统计', rows: monthly, widths: [10, 10, 15] },
  ];
}

/** 文件名：去掉 Windows/macOS 不允许的字符 */
export const exportFileName = (name, date) =>
  `${String(name).replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_').slice(0, 40) || '账本'}-${date}.xlsx`;
