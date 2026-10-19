// 数据层：配置了 Supabase 就走云端 RPC；否则退回浏览器 localStorage（仅本机可见，便于离线演示）
import { CONFIG } from './config.js';

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

const cloud = {
  createLedger: (name, members) => rpc('create_ledger', { p_name: name, p_members: members }),
  getLedger: (token) => rpc('get_ledger', { p_token: token }),
  addEntry: (token, e) => rpc('add_entry', {
    p_token: token, p_kind: e.kind, p_title: e.title, p_amount: e.amount,
    p_payer: e.payerId, p_participants: e.participantIds, p_spent_on: e.spentOn,
    // 均摊时不传新参数：数据库尚未迁移时，最常用的均摊记账仍然可用
    ...(e.splitMode && e.splitMode !== 'equal' ? { p_split_mode: e.splitMode, p_shares: e.shares } : {}),
  }),
  updateEntry: (token, id, e) => rpc('update_entry', {
    p_token: token, p_entry: id, p_title: e.title, p_amount: e.amount,
    p_payer: e.payerId, p_participants: e.participantIds, p_spent_on: e.spentOn,
    p_split_mode: e.splitMode ?? 'equal', p_shares: e.splitMode && e.splitMode !== 'equal' ? e.shares : null,
  }),
  deleteEntry: (token, id) => rpc('delete_entry', { p_token: token, p_entry: id }),
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

const local = {
  async createLedger(name, members) {
    const token = randomHex(16);
    writeLocal(token, { name, members: members.map((n) => ({ id: uuid(), name: n })), entries: [] });
    return token;
  },
  async getLedger(token) {
    const d = readLocal(token);
    d.members = d.members.map((m) => ({ ...m, left: Boolean(m.left) })); // 旧数据没有 left 字段
    return d;
  },
  async addEntry(token, e) {
    const d = readLocal(token);
    if (d.entries.length >= 2000) throw new StoreError('单个账本最多 2000 条记录');
    if (e.kind === 'expense') checkActive(d, e, []);
    const id = uuid();
    const splitMode = e.splitMode ?? 'equal';
    d.entries.unshift({ id, ...e, splitMode, shares: splitMode === 'equal' ? null : e.shares, createdAt: new Date().toISOString() });
    d.entries.sort((a, b) => (b.spentOn + b.createdAt).localeCompare(a.spentOn + a.createdAt));
    writeLocal(token, d);
    return id;
  },
  async deleteEntry(token, id) {
    const d = readLocal(token);
    d.entries = d.entries.filter((x) => x.id !== id);
    writeLocal(token, d);
  },
  // 以下规则与服务端 update_entry / add_member / rename_member / leave_member 保持一致
  async updateEntry(token, id, e) {
    const d = readLocal(token);
    const old = d.entries.find((x) => x.id === id);
    if (!old) throw new StoreError('记录不存在');
    if (old.kind !== 'expense') throw new StoreError('还款记录不能编辑，可以删除后重新标记');
    checkActive(d, e, [...old.participantIds, old.payerId]);
    const splitMode = e.splitMode ?? 'equal';
    Object.assign(old, {
      title: e.title, amount: e.amount, payerId: e.payerId, participantIds: e.participantIds, spentOn: e.spentOn,
      splitMode, shares: splitMode === 'equal' ? null : e.shares, updatedAt: new Date().toISOString(),
    });
    d.entries.sort((a, b) => (b.spentOn + b.createdAt).localeCompare(a.spentOn + a.createdAt));
    writeLocal(token, d);
  },
  async addMember(token, name) {
    const d = readLocal(token);
    const same = d.members.find((m) => m.name === name);
    if (same && !same.left) throw new StoreError('已有同名成员');
    if (d.members.filter((m) => !m.left).length >= 20) throw new StoreError('最多 20 位成员');
    if (same) { same.left = false; writeLocal(token, d); return same.id; }
    if (d.members.length >= 50) throw new StoreError('成员总数（含已退出）最多 50 位');
    const id = uuid();
    d.members.push({ id, name, left: false });
    writeLocal(token, d);
    return id;
  },
  async renameMember(token, id, name) {
    const d = readLocal(token);
    const m = d.members.find((x) => x.id === id);
    if (!m) throw new StoreError('成员不存在');
    if (d.members.some((x) => x.name === name && x.id !== id)) throw new StoreError('已有同名成员（含已退出的成员）');
    m.name = name;
    writeLocal(token, d);
  },
  async leaveMember(token, id) {
    const d = readLocal(token);
    const m = d.members.find((x) => x.id === id && !x.left);
    if (!m) throw new StoreError('成员不存在或已退出');
    if (d.members.filter((x) => !x.left).length <= 2) throw new StoreError('账本至少需要 2 位成员');
    m.left = true;
    writeLocal(token, d);
  },
};

/** 支出不能涉及已退出成员（extra 中的除外：编辑时保留原记录里的人） */
function checkActive(d, e, extra) {
  const left = new Set(d.members.filter((m) => m.left && !extra.includes(m.id)).map((m) => m.id));
  if ([e.payerId, ...e.participantIds].some((id) => left.has(id))) throw new StoreError('已退出的成员不能参与新的支出');
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
