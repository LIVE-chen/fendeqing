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

/** 分 → 输入框文本（编辑时回填）：1250 → "12.50"，不带千分位，parseAmount 可原样解析 */
export function centsToInput(cents) {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
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

export const isActive = (m) => !m.left;

/**
 * 能否退出账本：成员在账、退出后在账仍不少于 2 人、余额已结清。
 * 余额只在前端判断（结算算法只有 settle.js 这一份），服务端只兜底人数。
 */
export function canLeave(members, balances, id) {
  const m = members.find((x) => x.id === id);
  if (!m || !isActive(m)) return { ok: false, error: '成员不存在或已退出' };
  if (members.filter(isActive).length <= 2) return { ok: false, error: '账本至少需要 2 位成员' };
  const v = balances.get(id) ?? 0;
  if (v !== 0) return { ok: false, error: `${m.name}还有${v > 0 ? '应收' : '应付'} ${formatCents(Math.abs(v))} 未结清，结清后才能退出` };
  return { ok: true };
}

/** 校验单个成员名字：1~20 字，不与 others 重复 */
export function validateMemberName(name, others = []) {
  const n = String(name ?? '').trim();
  if (!n) return { ok: false, error: '请填写名字' };
  if (n.length > 20) return { ok: false, error: '成员名字最多 20 个字' };
  if (others.includes(n)) return { ok: false, error: '已有同名成员' };
  return { ok: true, name: n };
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

const ACTION_TEXT = {
  create: (d) => `创建账本「${d.name}」，成员：${(d.members ?? []).join('、')}`,
  add_entry: (d) => (d.kind === 'transfer' ? `记录还款 ${formatCents(d.amount)}`
    : `${d.recurring ? '自动记入周期账单' : '记一笔'}「${d.title}」${formatCents(d.amount)}`
      + (d.currency ? `（${formatForeign(d.origAmount, d.currency)}）` : '')),
  update_entry: (d) => {
    const parts = [];
    if (d.oldTitle !== d.title) parts.push(`「${d.oldTitle}」→「${d.title}」`);
    else parts.push(`「${d.title}」`);
    if (d.oldAmount !== d.amount) parts.push(`${formatCents(d.oldAmount)} → ${formatCents(d.amount)}`);
    return `编辑${parts.join(' ')}`;
  },
  delete_entry: (d) => `删除${d.kind === 'transfer' ? '还款' : ''}「${d.title}」${formatCents(d.amount)}`,
  restore_entry: (d) => `恢复${d.kind === 'transfer' ? '还款' : ''}「${d.title}」${formatCents(d.amount)}`,
  add_member: (d) => `添加成员${d.name}`,
  rename_member: (d) => `${d.oldName} 改名为 ${d.name}`,
  leave_member: (d) => `${d.name}退出账本`,
  restore_member: (d) => `${d.name}重新加入`,
  add_recurring: (d) => `新建周期账单「${d.title}」每月 ${d.day} 号 ${formatCents(d.amount)}`,
  delete_recurring: (d) => `删除周期账单「${d.title}」`,
};

/** 操作日志 → 一句话描述；未知类型（例如新版本才有的操作）不报错 */
export function describeActivity(a) {
  const f = ACTION_TEXT[a?.action];
  if (!f) return '其他操作';
  try { return f(a.detail ?? {}); } catch { return '其他操作'; }
}

// ---------- 周期账单的日期计算（与数据库 _next_month_day 规则一致，供本地模式使用） ----------
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m 为 1~12
const pad2 = (n) => String(n).padStart(2, '0');

/** "YYYY-MM-DD" 的下一个月第 dom 日；那个月没有这一天时取月底 */
export function nextMonthDay(iso, dom) {
  let [y, m] = iso.split('-').map(Number);
  m += 1;
  if (m > 12) { m = 1; y += 1; }
  return `${y}-${pad2(m)}-${pad2(Math.min(dom, daysIn(y, m)))}`;
}

/** 北京时间的今天（与服务端 _bj_today 一致，不受手机时区影响） */
export function bjToday(now = Date.now()) {
  return new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
}

/** 从 nextOn 起列出所有不晚于 today 的期数（最多 max 期），返回 { dates, nextOn } */
export function dueDates(nextOn, dom, today, max = Infinity) {
  const dates = [];
  let d = nextOn;
  while (d <= today && dates.length < max) { dates.push(d); d = nextMonthDay(d, dom); }
  return { dates, nextOn: d };
}

// ---------- 多币种（#13）：汇率由用户填写，不调用第三方汇率服务 ----------
// 原币金额统一以该币种的 1/100 为单位（日元、韩元也一样，最多两位小数）；
// 汇率以百万分之一为单位：1 外币 = rate / 1000000 人民币。折算规则与数据库 _fx_amount 一致。
export const CURRENCIES = [
  ['CNY', '人民币'], ['USD', '美元'], ['EUR', '欧元'], ['JPY', '日元'], ['KRW', '韩元'], ['HKD', '港币'],
  ['MOP', '澳门元'], ['TWD', '新台币'], ['GBP', '英镑'], ['THB', '泰铢'], ['SGD', '新加坡元'], ['AUD', '澳元'],
  ['MYR', '林吉特'], ['VND', '越南盾'],
];
export const currencyName = (code) => CURRENCIES.find(([c]) => c === code)?.[1] ?? code;
export const MAX_FOREIGN = 1_000_000_000_000; // 原币最多 100 亿
export const MAX_RATE = 1_000_000_000; // 汇率最多 1000

/** 外币金额 "3000" / "12.5" → 1/100 单位；非法返回 null */
export function parseForeign(input) {
  const s = String(input ?? '').trim().replace(/,/g, '');
  if (!/^\d{1,11}(\.\d{1,2})?$/.test(s)) return null;
  const [a, f = ''] = s.split('.');
  const v = Number(a) * 100 + Number((f + '00').slice(0, 2));
  return v >= 1 && v <= MAX_FOREIGN ? v : null;
}

/** 汇率 "0.048123" → 48123（最多 6 位小数，大于 0 且不超过 1000）；非法返回 null */
export function parseRate(input) {
  const s = String(input ?? '').trim();
  if (!/^\d{1,4}(\.\d{1,6})?$/.test(s)) return null;
  const [a, f = ''] = s.split('.');
  const v = Number(a) * 1_000_000 + Number((f + '000000').slice(0, 6));
  return v >= 1 && v <= MAX_RATE ? v : null;
}

/** 48123 → "0.048123"；7100000 → "7.1"（编辑时回填） */
export function rateToInput(rate) {
  const f = String(rate % 1_000_000).padStart(6, '0').replace(/0+$/, '');
  return `${Math.floor(rate / 1_000_000)}${f ? '.' + f : ''}`;
}

/** 原币 × 汇率 → 人民币分，四舍五入。用 BigInt：乘积可达 10^21，超过 2^53 */
export function fxToCents(orig, rate) {
  return Number((BigInt(orig) * BigInt(rate) + 500_000n) / 1_000_000n);
}

/** "JPY 3,000.00" */
export function formatForeign(orig, code) {
  return `${code} ${Math.floor(orig / 100).toLocaleString('zh-CN')}.${String(orig % 100).padStart(2, '0')}`;
}
