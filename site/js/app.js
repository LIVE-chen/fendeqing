import { validateMembers } from './settle.js';
import { store, isCloud, isValidToken, getRecent, rememberLedger, forgetLedger } from './store.js';
import { h, $, toast, errMsg, withBusy } from './ui.js';
import { renderLedger } from './ledger.js';

const app = $('#app');

$('#mode-badge').textContent = isCloud ? '云端同步' : '本机模式';
$('#mode-badge').title = isCloud ? '数据保存在云端，拿到链接的人都能查看和记账' : '未配置云端，数据仅保存在当前浏览器';

// ---------- 首页 ----------
function renderHome() {
  document.title = '分得清 · 合租旅行 AA 账本';
  const memberList = h('div', { class: 'member-inputs' });
  const addMemberInput = (value = '') => {
    const input = h('input', { name: 'member', maxlength: 20, placeholder: `成员 ${memberList.children.length + 1}`, value, autocomplete: 'off', 'aria-label': '成员名字' });
    const row = h('div', { class: 'row' }, input,
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': '移除该成员', onclick: () => { if (memberList.children.length > 2) row.remove(); } }, '×'));
    memberList.append(row);
    return input;
  };
  ['我', ''].forEach((v) => addMemberInput(v));
  addMemberInput();

  const err = h('p', { class: 'form-error', role: 'alert' });
  const submit = h('button', { type: 'submit', class: 'btn primary block' }, '创建账本');
  const form = h('form', { class: 'card', novalidate: true, onsubmit: (ev) => {
    ev.preventDefault();
    err.textContent = '';
    const name = form.elements.ledgerName.value.trim();
    if (!name) { err.textContent = '给账本起个名字吧'; return; }
    if (name.length > 40) { err.textContent = '账本名字最多 40 个字'; return; }
    const names = [...memberList.querySelectorAll('input')].map((i) => i.value);
    const v = validateMembers(names);
    if (!v.ok) { err.textContent = v.error; return; }
    withBusy(submit, async () => {
      try {
        const token = await store.createLedger(name, v.names);
        rememberLedger(token, name);
        location.hash = `#/l/${token}`;
        toast('账本已创建，把链接发给室友就能一起记账');
      } catch (e) { err.textContent = errMsg(e); }
    });
  } },
    h('h2', {}, '新建账本'),
    h('label', {}, '账本名字', h('input', { name: 'ledgerName', maxlength: 40, placeholder: '例如：502 合租 / 云南五日游', autocomplete: 'off', required: true })),
    h('div', { class: 'label' }, '成员（2~20 人）'),
    memberList,
    h('button', { type: 'button', class: 'link', onclick: () => {
      if (memberList.children.length >= 20) { err.textContent = '最多 20 位成员'; return; }
      addMemberInput().focus();
    } }, '+ 再加一位'),
    err, submit);

  const recent = getRecent();
  app.replaceChildren(...[
    h('section', { class: 'hero' },
      h('h1', {}, '合租、旅行、聚餐，账一次分清'),
      h('p', {}, '免注册 · 不限记账条数 · 自动算出最少转账'),
    ),
    form,
    recent.length ? h('section', { class: 'card' }, h('h2', {}, '最近打开'),
      h('ul', { class: 'list' }, recent.map((r) => h('li', {},
        h('a', { href: `#/l/${r.token}`, class: 'list-link' }, r.name),
        h('button', { class: 'icon-btn', 'aria-label': `从列表移除 ${r.name}`, onclick: () => { forgetLedger(r.token); renderHome(); } }, '×'))))) : null,
    h('section', { class: 'steps' },
      h('div', {}, h('b', {}, '1'), '建账本，加成员'),
      h('div', {}, h('b', {}, '2'), '发链接，谁付钱谁记'),
      h('div', {}, h('b', {}, '3'), '看结算，一键标记已还')),
  ].filter(Boolean));
}

// ---------- 路由 ----------
// token 放在 # 片段里：不会出现在服务器访问日志和 Referer 中
function route() {
  const m = location.hash.match(/^#\/l\/([^/?]+)/);
  if (m) {
    if (!isValidToken(m[1])) {
      app.replaceChildren(h('section', { class: 'card empty' }, h('h2', {}, '链接无效'),
        h('p', {}, '请确认链接是否复制完整。'), h('a', { class: 'btn primary', href: '#/' }, '返回首页')));
      return;
    }
    renderLedger(app, m[1]);
  } else {
    renderHome();
  }
  app.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);
route();
