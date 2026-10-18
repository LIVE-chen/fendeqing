// 纯函数：金额解析、均摊、余额、最少转账。全部使用"分"为单位的整数，避免浮点误差。

export const MAX_AMOUNT_CENTS = 10_000_000_00; // 单笔上限 1000 万元

/** 把用户输入的 "12.5" / "12.50" / "￥12" 解析成分；非法返回 null */
export function parseAmount(input) {
  if (typeof input !== 'string' && typeof input !== 'number') return null;
  const s = String(input).trim().replace(/^[¥￥]/, '').replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [yuan, frac = ''] = s.split('.');
  const cents = Number(yuan) * 100 + Number((frac + '00').slice(0, 2));
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > MAX_AMOUNT_CENTS) return null;
  return cents;
}

export function formatCents(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const yuan = Math.floor(abs / 100).toLocaleString('zh-CN');
  const frac = String(abs % 100).padStart(2, '0');
  return `${sign}¥${yuan}.${frac}`;
}

/** 把 amount 均分成 n 份，余下的分依次分给前面的人，保证总和不变 */
export function splitEqual(amount, n) {
  if (n <= 0) return [];
  const base = Math.floor(amount / n);
  const rest = amount - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < rest ? 1 : 0));
}

/**
 * 余额 = 已付 - 应摊。正数表示别人欠他，负数表示他欠别人。
 * entries: { payerId, amount, participantIds }[]（转账也用同一模型：付款人=还钱的人，参与人=收钱的人）
 */
export function computeBalances(members, entries) {
  const order = new Map(members.map((m, i) => [m.id, i]));
  const bal = new Map(members.map((m) => [m.id, 0]));
  for (const e of entries) {
    const parts = e.participantIds
      .filter((id) => order.has(id))
      .sort((a, b) => order.get(a) - order.get(b));
    if (!order.has(e.payerId) || parts.length === 0) continue;
    bal.set(e.payerId, bal.get(e.payerId) + e.amount);
    splitEqual(e.amount, parts.length).forEach((share, i) => {
      bal.set(parts[i], bal.get(parts[i]) - share);
    });
  }
  return bal;
}

/** 贪心：最大债务人还给最大债权人，最多产生 n-1 笔转账 */
export function minimizeTransfers(balances) {
  const creditors = [];
  const debtors = [];
  for (const [id, v] of balances) {
    if (v > 0) creditors.push({ id, v });
    else if (v < 0) debtors.push({ id, v: -v });
  }
  const byAmount = (a, b) => b.v - a.v;
  creditors.sort(byAmount);
  debtors.sort(byAmount);
  const transfers = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].v, creditors[j].v);
    transfers.push({ from: debtors[i].id, to: creditors[j].id, amount: pay });
    debtors[i].v -= pay;
    creditors[j].v -= pay;
    if (debtors[i].v === 0) i++;
    if (creditors[j].v === 0) j++;
  }
  return transfers;
}

/** 校验成员名单：2~20 人，每个名字 1~20 字，不能重复 */
export function validateMembers(names) {
  const cleaned = names.map((n) => String(n ?? '').trim()).filter(Boolean);
  if (cleaned.length < 2) return { ok: false, error: '至少需要 2 位成员' };
  if (cleaned.length > 20) return { ok: false, error: '最多 20 位成员' };
  if (cleaned.some((n) => n.length > 20)) return { ok: false, error: '成员名字最多 20 个字' };
  if (new Set(cleaned).size !== cleaned.length) return { ok: false, error: '成员名字不能重复' };
  return { ok: true, names: cleaned };
}
