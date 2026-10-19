import { StoreError } from './store.js';

// 所有用户内容都通过 textContent / 文本节点写入，不使用 innerHTML，杜绝 XSS
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const $ = (s) => document.querySelector(s);

let toastTimer;
/** action: { label, onClick } 时在提示里放一个按钮（例如"撤销"），显示时间延长到 6 秒 */
export function toast(msg, isError = false, action = null) {
  const t = $('#toast');
  t.replaceChildren(h('span', {}, msg));
  if (action) {
    t.append(h('button', {
      type: 'button', class: 'toast-action',
      onclick: () => { t.hidden = true; clearTimeout(toastTimer); action.onClick(); },
    }, action.label));
  }
  t.classList.toggle('error', isError);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, action ? 6000 : 2600);
}

export const errMsg = (e) => (e instanceof StoreError ? e.message : '出了点问题，请刷新后重试');

export const today = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

/** 防重复提交：执行期间禁用按钮 */
export async function withBusy(btn, fn) {
  if (btn.disabled) return;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '处理中…';
  try { await fn(); } finally { btn.disabled = false; btn.textContent = label; }
}
