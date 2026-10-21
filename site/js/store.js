// 数据层：配置了 Supabase 就走云端 RPC；否则退回浏览器 localStorage（仅本机可见，便于离线演示）
import { CONFIG } from './config.js';
import { bjToday, dueDates, fxToCents, MAX_AMOUNT_CENTS } from './settle.js';

const TOKEN_RE = /^[0-9a-f]{32}$/;
export const isCloud = Boolean(CONFIG.supabaseUrl && CONFIG.supabaseAnonKey);

export class StoreError extends Error {}
const USER_ERRCODES = new Set(['P0002', '22023', '54000']);

// ---------- 云端 ----------
async function rpc(fn, args) {
  let res;
  try {
    res = await fetch(`${CONFIG.supabaseUrl}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: CONFIG.supabaseAnonKey,
        Authorization: `Bearer ${CONFIG.supabaseAnonKey}`,
      },
      body: JSON.stringify(args),
    });
  } catch {
    throw new StoreError('网络连接失败，请检查网络后重试');
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* 非 JSON 响应 */ }
  if (!res.ok) {
    console.error('[rpc]', fn, res.status, data ?? text);
    // 只展示数据库函数主动抛出的业务错误（errcode 白名单），其他错误统一模糊处理，避免泄露表结构
    const msg = data && USER_ERRCODES.has(data.code) && typeof data.message === 'string'
      ? data.message.slice(0, 80) : '服务暂时不可用，请稍后再试';
    throw new StoreError(msg);
  }
  return data;
}

// 人民币支出不传外币参数：数据库尚未迁移时人民币记账仍然可用
const fxArgs = (e) => (e.currency ? { p_currency: e.currency, p_orig_amount: e.origAmount, p_fx_rate: e.fxRate } : {});

const cloud = {
  createLedger: (name, members) => rpc('create_ledger', { p_name: name, p_members: members }),
  getLedger: (token) => rpc('get_ledger', { p_token: token }),
  addEntry: (token, e) => rpc('add_entry', {
    p_token: token, p_kind: e.kind, p_title: e.title, p_amount: e.amount,
    p_payer: e.payerId, p_participants: e.participantIds, p_spent_on: e.spentOn,
    // 均摊时不传新参数：数据库尚未迁移时，最常用的均摊记账仍然可用
    ...(e.splitMode && e.splitMode !== 'equal' ? { p_split_mode: e.splitMode, p_shares: e.shares } : {}),
    ...fxArgs(e),
  }),
  updateEntry: (token, id, e) => rpc('update_entry', {
    p_token: token, p_entry: id, p_title: e.title, p_amount: e.amount,
    p_payer: e.payerId, p_participants: e.participantIds, p_spent_on: e.spentOn,
    p_split_mode: e.splitMode ?? 'equal', p_shares: e.splitMode && e.splitMode !== 'equal' ? e.shares : null,
    ...fxArgs(e),
  }),
  deleteEntry: (token, id) => rpc('delete_entry', { p_token: token, p_entry: id }),
  restoreEntry: (token, id) => rpc('restore_entry', { p_token: token, p_entry: id }),
  getHistory: (token) => rpc('get_history', { p_token: token }),
  addRecurring: (token, r) => rpc('add_recurring', {
    p_token: token, p_title: r.title, p_amount: r.amount, p_payer: r.payerId,
    p_participants: r.participantIds, p_start_on: r.startOn,
    ...(r.splitMode && r.splitMode !== 'equal' ? { p_split_mode: r.splitMode, p_shares: r.shares } : {}),
  }),
  deleteRecurring: (token, id) => rpc('delete_recurring', { p_token: token, p_recurring: id }),
  runRecurring: (token) => rpc('run_recurring', { p_token: token }),
  addMember: (token, name) => rpc('add_member', { p_token: token, p_name: name }),
  renameMember: (token, id, name) => rpc('rename_member', { p_token: token, p_member: id, p_name: name }),
  leaveMember: (token, id) => rpc('leave_member', { p_token: token, p_member: id }),
};

// ---------- 本地 ----------
const KEY = (t) => `fdq:ledger:${t}`;
const randomHex = (bytes) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : randomHex(16));

function readLocal(token) {
  if (!TOKEN_RE.test(token)) throw new StoreError('账本链接无效');
  const raw = localStorage.getItem(KEY(token));
  if (!raw) throw new StoreError('账本不存在或已删除');
  try { return JSON.parse(raw); } catch { throw new StoreError('本地数据已损坏'); }
}
function writeLocal(token, data) {
  try { localStorage.setItem(KEY(token), JSON.stringify(data)); }
  catch { throw new StoreError('浏览器存储空间不足，保存失败'); }
}

// 本地模式的规则与服务端函数保持一致（软删除、回收站上限、操作日志）
const now = () => new Date().toISOString();
const byDate = (a, b) => (b.spentOn + b.createdAt).localeCompare(a.spentOn + a.createdAt);
function log(d, action, detail) {
  d.activities = [{ at: now(), action, detail }, ...(d.activities ?? [])].slice(0, 500);
}
const local = {
  async createLedger(name, members) {
    const token = randomHex(16);
    const d = { name, members: members.map((n) => ({ id: uuid(), name: n })), entries: [], deleted: [], activities: [] };
    log(d, 'create', { name, members });
    writeLocal(token, d);
    return token;
  },
  async getLedger(token) {
    const d = readLocal(token);
    // 旧数据没有 left / deleted / activities / recurring 字段
    return {
      name: d.name, members: d.members.map((m) => ({ ...m, left: Boolean(m.left) })), entries: d.entries,
      recurring: d.recurring ?? [], today: bjToday(),
    };
  },
  async addRecurring(token, r) {
    const d = readLocal(token);
    d.recurring ??= [];
    if (d.recurring.length >= 20) throw new StoreError('每个账本最多 20 个周期账单');
    const today = bjToday();
    const shift = (days) => new Date(Date.parse(today) + days * 86400_000).toISOString().slice(0, 10);
    if (!r.startOn || r.startOn < shift(-366) || r.startOn > shift(366)) throw new StoreError('首次日期需在前后一年内');
    checkActive(d, r, []);
    const id = uuid();
    const splitMode = r.splitMode ?? 'equal';
    const dayOfMonth = Number(r.startOn.slice(8, 10));
    d.recurring.push({
      id, title: r.title, amount: r.amount, payerId: r.payerId, participantIds: r.participantIds,
      splitMode, shares: splitMode === 'equal' ? null : r.shares, dayOfMonth, nextOn: r.startOn,
    });
    log(d, 'add_recurring', { title: r.title, amount: r.amount, day: dayOfMonth });
    const added = runLocal(d);
    writeLocal(token, d);
    return { id, added };
  },
  async deleteRecurring(token, id) {
    const d = readLocal(token);
    const r = (d.recurring ?? []).find((x) => x.id === id);
    if (!r) throw new StoreError('周期账单不存在');
    d.recurring = d.recurring.filter((x) => x !== r);
    for (const e of [...d.entries, ...(d.deleted ?? [])]) if (e.recurringId === id) e.recurringId = null;
    log(d, 'delete_recurring', { title: r.title, amount: r.amount });
    writeLocal(token, d);
  },
  async runRecurring(token) {
    const d = readLocal(token);
    const added = runLocal(d);
    if (added) writeLocal(token, d);
    return added;
  },
  async getHistory(token) {
    const d = readLocal(token);
    const cutoff = Date.now() - 30 * 86400_000;
    return {
      deleted: (d.deleted ?? []).filter((e) => Date.parse(e.deletedAt) >= cutoff).slice(0, 100),
      activities: (d.activities ?? []).slice(0, 100),
    };
  },
  async addEntry(token, e) {
    const d = readLocal(token);
    if (d.entries.length >= 2000) throw new StoreError('单个账本最多 2000 条记录');
    if (e.kind === 'expense') checkActive(d, e, []);
    e = { ...e, ...fxLocal(e) };
    const id = uuid();
    const splitMode = e.splitMode ?? 'equal';
    d.entries.unshift({ id, ...e, splitMode, shares: splitMode === 'equal' ? null : e.shares, createdAt: now() });
    d.entries.sort(byDate);
    log(d, 'add_entry', { kind: e.kind, title: e.title, amount: e.amount, ...(e.currency ? { currency: e.currency, origAmount: e.origAmount } : {}) });
    writeLocal(token, d);
    return id;
  },
  async deleteEntry(token, id) {
    const d = readLocal(token);
    const e = d.entries.find((x) => x.id === id);
    if (!e) throw new StoreError('记录不存在');
    d.entries = d.entries.filter((x) => x !== e);
    const cutoff = Date.now() - 30 * 86400_000;
    d.deleted = [{ ...e, deletedAt: now() }, ...(d.deleted ?? [])].filter((x) => Date.parse(x.deletedAt) >= cutoff).slice(0, 100);
    log(d, 'delete_entry', { kind: e.kind, title: e.title, amount: e.amount });
    writeLocal(token, d);
  },
  async restoreEntry(token, id) {
    const d = readLocal(token);
    const e = (d.deleted ?? []).find((x) => x.id === id);
    if (!e) throw new StoreError('记录不存在或已恢复');
    if (d.entries.length >= 2000) throw new StoreError('单个账本最多 2000 条记录');
    d.deleted = d.deleted.filter((x) => x !== e);
    const { deletedAt, ...rest } = e;
    d.entries.push(rest);
    d.entries.sort(byDate);
    log(d, 'restore_entry', { kind: e.kind, title: e.title, amount: e.amount });
    writeLocal(token, d);
  },
  async updateEntry(token, id, e) {
    const d = readLocal(token);
    const old = d.entries.find((x) => x.id === id);
    if (!old) throw new StoreError('记录不存在');
    if (old.kind !== 'expense') throw new StoreError('还款记录不能编辑，可以删除后重新标记');
    checkActive(d, e, [...old.participantIds, old.payerId]);
    e = { ...e, ...fxLocal({ ...e, kind: 'expense' }) };
    const splitMode = e.splitMode ?? 'equal';
    log(d, 'update_entry', { title: e.title, amount: e.amount, oldTitle: old.title, oldAmount: old.amount });
    Object.assign(old, {
      title: e.title, amount: e.amount, payerId: e.payerId, participantIds: e.participantIds, spentOn: e.spentOn,
      splitMode, shares: splitMode === 'equal' ? null : e.shares, updatedAt: now(),
      currency: e.currency, origAmount: e.origAmount, fxRate: e.fxRate,
    });
    d.entries.sort(byDate);
    writeLocal(token, d);
  },
  async addMember(token, name) {
    const d = readLocal(token);
    const same = d.members.find((m) => m.name === name);
    if (same && !same.left) throw new StoreError('已有同名成员');
    if (d.members.filter((m) => !m.left).length >= 20) throw new StoreError('最多 20 位成员');
    if (same) { same.left = false; log(d, 'restore_member', { name }); writeLocal(token, d); return same.id; }
    if (d.members.length >= 50) throw new StoreError('成员总数（含已退出）最多 50 位');
    const id = uuid();
    d.members.push({ id, name, left: false });
    log(d, 'add_member', { name });
    writeLocal(token, d);
    return id;
  },
  async renameMember(token, id, name) {
    const d = readLocal(token);
    const m = d.members.find((x) => x.id === id);
    if (!m) throw new StoreError('成员不存在');
    if (d.members.some((x) => x.name === name && x.id !== id)) throw new StoreError('已有同名成员（含已退出的成员）');
    log(d, 'rename_member', { name, oldName: m.name });
    m.name = name;
    writeLocal(token, d);
  },
  async leaveMember(token, id) {
    const d = readLocal(token);
    const m = d.members.find((x) => x.id === id && !x.left);
    if (!m) throw new StoreError('成员不存在或已退出');
    if (d.members.filter((x) => !x.left).length <= 2) throw new StoreError('账本至少需要 2 位成员');
    if ((d.recurring ?? []).some((r) => r.payerId === id || r.participantIds.includes(id))) {
      throw new StoreError('该成员还在周期账单里，请先删除相关的周期账单');
    }
    m.left = true;
    log(d, 'leave_member', { name: m.name });
    writeLocal(token, d);
  },
};

/** 外币折算（与服务端 _fx_amount 一致）：返回 { amount, currency, origAmount, fxRate }，人民币时三项为 null */
function fxLocal(e) {
  if (!e.currency) return { amount: e.amount, currency: null, origAmount: null, fxRate: null };
  if (e.kind !== 'expense') throw new StoreError('还款只支持人民币');
  if (!/^[A-Z]{3}$/.test(e.currency) || e.currency === 'CNY') throw new StoreError('币种不合法');
  if (!(e.origAmount >= 1 && e.origAmount <= 1e12)) throw new StoreError('外币金额需大于 0 且不超过 100 亿');
  if (!(e.fxRate >= 1 && e.fxRate <= 1e9)) throw new StoreError('汇率需大于 0 且不超过 1000');
  if (e.splitMode === 'amount') throw new StoreError('外币支出请用均摊或按比例');
  const amount = fxToCents(e.origAmount, e.fxRate);
  if (amount < 1 || amount > MAX_AMOUNT_CENTS) throw new StoreError('金额需大于 0 且不超过 1000 万');
  return { amount, currency: e.currency, origAmount: e.origAmount, fxRate: e.fxRate };
}

/** 支出不能涉及已退出成员（extra 中的除外：编辑时保留原记录里的人） */
function checkActive(d, e, extra) {
  const left = new Set(d.members.filter((m) => m.left && !extra.includes(m.id)).map((m) => m.id));
  if ([e.payerId, ...e.participantIds].some((id) => left.has(id))) throw new StoreError('已退出的成员不能参与新的支出');
}

/** 补记到期的周期账单（与服务端 _run_recurring 一致：满 2000 条时暂停，nextOn 不前进） */
function runLocal(d) {
  const today = bjToday();
  let added = 0;
  const due = (d.recurring ?? []).filter((r) => r.nextOn <= today)
    .sort((a, b) => a.nextOn.localeCompare(b.nextOn) || a.id.localeCompare(b.id));
  for (const r of due) {
    const { dates, nextOn } = dueDates(r.nextOn, r.dayOfMonth, today, Math.max(0, 2000 - d.entries.length));
    for (const spentOn of dates) {
      d.entries.push({
        id: uuid(), kind: 'expense', title: r.title, amount: r.amount, payerId: r.payerId,
        participantIds: [...r.participantIds], spentOn, splitMode: r.splitMode, shares: r.shares,
        recurringId: r.id, createdAt: now(),
      });
      log(d, 'add_entry', { kind: 'expense', title: r.title, amount: r.amount, recurring: true });
      added += 1;
    }
    r.nextOn = nextOn;
  }
  if (added) d.entries.sort(byDate);
  return added;
}

export const store = isCloud ? cloud : local;
export const isValidToken = (t) => TOKEN_RE.test(t);

// ---------- 最近打开的账本（只存本机，方便回到账本） ----------
const RECENT = 'fdq:recent';
export function getRecent() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT) || '[]');
    return Array.isArray(list) ? list.filter((x) => x && isValidToken(x.token)).slice(0, 10) : [];
  } catch { return []; }
}
export function rememberLedger(token, name) {
  const list = getRecent().filter((x) => x.token !== token);
  list.unshift({ token, name: String(name).slice(0, 40), at: Date.now() });
  try { localStorage.setItem(RECENT, JSON.stringify(list.slice(0, 10))); } catch { /* ignore */ }
}
export function forgetLedger(token) {
  try { localStorage.setItem(RECENT, JSON.stringify(getRecent().filter((x) => x.token !== token))); } catch { /* ignore */ }
}
