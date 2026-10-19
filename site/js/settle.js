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

export const SPLIT_MODES = ['equal', 'ratio', 'amount'];
export const MAX_RATIO = 1000;

/**
 * 按权重分配 amount（最大余数法）：先按比例向下取整，剩下的分按小数部分从大到小补，
 * 小数部分相同时补给排在前面的人。总和恒等于 amount。
 * 用 BigInt 计算：按金额分摊时权重可达 10 亿，amount × 权重会超过 2^53。
 * 权重全为 1 时结果与 splitEqual 相同；权重之和等于 amount 时，每人恰好分到自己的权重值。
 */
export function splitByWeights(amount, weights) {
  const n = weights.length;
  if (n === 0) return [];
  const A = BigInt(amount);
  const W = weights.reduce((s, w) => s + BigInt(w), 0n);
  if (W <= 0n) return splitEqual(amount, n);
  const base = weights.map((w) => (A * BigInt(w)) / W);
  const rem = weights.map((w, i) => ({ i, r: (A * BigInt(w)) % W }));
  let left = Number(A - base.reduce((s, x) => s + x, 0n));
  rem.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (let k = 0; left > 0; k++, left--) base[rem[k].i] += 1n;
  return base.map(Number);
}

/**
 * 一笔记录里每个参与人应摊多少：返回 [[memberId, cents], ...]，按成员顺序排列。
 * 不在账本里的参与人会被忽略，剩下的人按原权重重新分摊全额，保证余额总和为 0。
 */
export function entryShares(members, e) {
  const order = new Map(members.map((m, i) => [m.id, i]));
  const weighted = (e.splitMode === 'ratio' || e.splitMode === 'amount') && Array.isArray(e.shares)
    && e.shares.length === e.participantIds.length;
  const pairs = e.participantIds
    .map((id, k) => [id, weighted ? e.shares[k] : 1])
    .filter(([id]) => order.has(id))
    .sort((a, b) => order.get(a[0]) - order.get(b[0]));
  const cents = splitByWeights(e.amount, pairs.map((p) => p[1]));
  return pairs.map(([id], k) => [id, cents[k]]);
}

/**
 * 余额 = 已付 - 应摊。正数表示别人欠他，负数表示他欠别人。
 * entries: { payerId, amount, participantIds, splitMode?, shares? }[]
 * 转账也用同一模型：付款人=还钱的人，参与人=收钱的人。
 */
export function computeBalances(members, entries) {
  const order = new Map(members.map((m, i) => [m.id, i]));
  const bal = new Map(members.map((m) => [m.id, 0]));
  for (const e of entries) {
    if (!order.has(e.payerId)) continue;
    const shares = entryShares(members, e);
    if (shares.length === 0) continue;
    bal.set(e.payerId, bal.get(e.payerId) + e.amount);
    for (const [id, c] of shares) bal.set(id, bal.get(id) - c);
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

/**
 * 校验分摊输入。mode：equal / ratio / amount；inputs：与参与人一一对应的输入字符串。
 * 返回 { ok: true, shares }（均摊时 shares 为 null）或 { ok: false, error }。
 */
export function parseSplit(mode, amount, inputs) {
  if (mode === 'equal') return { ok: true, shares: null };
  if (mode === 'ratio') {
    const shares = inputs.map((s) => (/^\s*\d{1,4}\s*$/.test(String(s ?? '')) ? Number(s) : NaN));
    if (shares.some((x) => !(x >= 1 && x <= MAX_RATIO))) return { ok: false, error: `比例请填 1~${MAX_RATIO} 的整数` };
    return { ok: true, shares };
  }
  if (mode === 'amount') {
    const shares = inputs.map((s) => parseAmount(String(s ?? '')));
    if (shares.some((x) => x == null)) return { ok: false, error: '每人金额需大于 0，最多两位小数' };
    const sum = shares.reduce((a, b) => a + b, 0);
    if (amount != null && sum !== amount) {
      const diff = amount - sum;
      return { ok: false, error: `各人金额合计 ${formatCents(sum)}，${diff > 0 ? '还差' : '多了'} ${formatCents(Math.abs(diff))}` };
    }
    return { ok: true, shares };
  }
  return { ok: false, error: '分摊方式不合法' };
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
