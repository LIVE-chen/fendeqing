import { parseAmount, formatCents, computeBalances, minimizeTransfers, parseSplit, entryShares } from './settle.js';
import { store, isCloud, rememberLedger } from './store.js';
import { h, $, toast, errMsg, today, withBusy } from './ui.js';

let state = null; // { token, name, members, entries }
let renderSeq = 0; // 每次渲染递增；请求返回时序号已过期就丢弃结果，避免快速切换账本时旧数据覆盖新页面

const isCurrent = (seq, token) => seq === renderSeq && location.hash.startsWith(`#/l/${token}`);

// quiet=true：操作后刷新时保留当前内容，避免云端请求期间页面闪成"加载中"
export async function renderLedger(root, token, { quiet = false } = {}) {
  const seq = ++renderSeq;
  if (!quiet) root.replaceChildren(h('section', { class: 'card empty' }, h('p', {}, '加载中…')));
  else root.setAttribute('aria-busy', 'true');
  try {
    const data = await store.getLedger(token);
    if (!isCurrent(seq, token)) return;
    state = { token, ...data };
    rememberLedger(token, data.name);
    paint(root);
    root.removeAttribute('aria-busy');
  } catch (e) {
    console.error('[load]', e);
    if (!isCurrent(seq, token)) return;
    root.removeAttribute('aria-busy');
    if (quiet) { toast(errMsg(e), true); return; }
    root.replaceChildren(h('section', { class: 'card empty' },
      h('h2', {}, '打不开这个账本'), h('p', {}, errMsg(e)),
      h('div', { class: 'actions' },
        h('button', { class: 'btn ghost', onclick: () => renderLedger(root, token) }, '重试'),
        h('a', { class: 'btn primary', href: '#/' }, '返回首页'))));
  }
}

const nameOf = (id) => state.members.find((m) => m.id === id)?.name ?? '已删除成员';

function paint(root) {
  document.title = `${state.name} · 分得清`;
  const balances = computeBalances(state.members, state.entries);
  const transfers = minimizeTransfers(balances);
  const expenses = state.entries.filter((e) => e.kind === 'expense');
  const total = expenses.reduce((s, e) => s + e.amount, 0);

  const shareUrl = location.href;
  const header = h('section', { class: 'card ledger-head' },
    h('div', {},
      h('h1', {}, state.name),
      h('p', { class: 'muted' }, `${state.members.length} 人 · 共 ${expenses.length} 笔支出 · 合计 ${formatCents(total)}`)),
    h('div', { class: 'actions wrap' },
      h('button', { class: 'btn ghost', onclick: () => copyLink(shareUrl) }, isCloud ? '复制邀请链接' : '复制链接'),
      h('button', { class: 'btn ghost', 'aria-label': '刷新账本', onclick: () => renderLedger(root, state.token) }, '刷新')));

  const settle = h('section', { class: 'card', id: 'settle' },
    h('h2', {}, '结算方案'),
    transfers.length === 0
      ? h('p', { class: 'muted' }, state.entries.length ? '账已经平了，没有人欠钱。' : '还没有记录，先记一笔吧。')
      : h('ul', { class: 'list' }, transfers.map((t) => h('li', { class: 'transfer' },
          h('span', {}, h('b', {}, nameOf(t.from)), ' → ', h('b', {}, nameOf(t.to))),
          h('span', { class: 'amount' }, formatCents(t.amount)),
          h('button', { class: 'btn small', onclick: (ev) => markRepaid(root, ev.currentTarget, t) }, '标记已还')))),
    transfers.length ? h('p', { class: 'hint' }, `按最少转账计算：${transfers.length} 笔就能结清`) : null);

  const balanceList = h('section', { class: 'card', id: 'balances' },
    h('h2', {}, '每人余额'),
    h('ul', { class: 'list' }, state.members.map((m) => {
      const v = balances.get(m.id) ?? 0;
      return h('li', {},
        h('span', {}, m.name),
        h('span', { class: `amount ${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}` },
          v > 0 ? `应收 ${formatCents(v)}` : v < 0 ? `应付 ${formatCents(-v)}` : '已结清'));
    })));

  const entryList = h('section', { class: 'card' },
    h('h2', {}, '流水'),
    state.entries.length === 0
      ? h('p', { class: 'muted' }, '暂无记录')
      : h('ul', { class: 'list entries' }, state.entries.map((e) => {
          const isT = e.kind === 'transfer';
          const weighted = e.splitMode === 'ratio' || e.splitMode === 'amount';
          const who = weighted
            ? entryShares(state.members, e).map(([id, c]) => `${nameOf(id)} ${formatCents(c)}`).join('、')
            : `${e.participantIds.length === state.members.length ? '全员' : e.participantIds.map(nameOf).join('、')} 分摊`;
          const sub = isT
            ? `${nameOf(e.payerId)} 还给 ${nameOf(e.participantIds[0])}`
            : `${nameOf(e.payerId)} 付款 · ${weighted ? (e.splitMode === 'ratio' ? '按比例：' : '按金额：') : ''}${who}`;
          return h('li', {},
            h('div', { class: 'entry-main' },
              h('div', { class: 'entry-title' }, isT ? h('span', { class: 'tag' }, '还款') : null, e.title),
              h('div', { class: 'muted small' }, `${e.spentOn} · ${sub}`)),
            h('span', { class: 'amount' }, formatCents(e.amount)),
            h('button', { class: 'icon-btn', 'aria-label': `删除 ${e.title}`, onclick: (ev) => removeEntry(root, ev.currentTarget, e) }, '×'));
        })));

  const fab = h('button', { class: 'fab', onclick: () => openEntryDialog(root) }, '+ 记一笔');
  root.replaceChildren(header, settle, balanceList, entryList, fab);
}

async function copyLink(url) {
  try {
    await navigator.clipboard.writeText(url);
    toast(isCloud ? '链接已复制，发到室友群里即可一起记账' : '链接已复制（本机模式下仅当前浏览器可打开）');
  } catch {
    window.prompt('复制下面的链接：', url);
  }
}

async function markRepaid(root, btn, t) {
  if (!confirm(`确认 ${nameOf(t.from)} 已向 ${nameOf(t.to)} 转账 ${formatCents(t.amount)}？`)) return;
  await withBusy(btn, async () => {
    try {
      // 写入前重新拉取：别的设备可能已经记过这笔还款，避免按过时的结算方案重复记账
      const latest = await store.getLedger(state.token);
      const still = minimizeTransfers(computeBalances(latest.members, latest.entries))
        .some((x) => x.from === t.from && x.to === t.to && x.amount === t.amount);
      if (!still) {
        toast('账本已被其他人更新，已刷新结算方案', true);
        await renderLedger(root, state.token, { quiet: true });
        return;
      }
      await store.addEntry(state.token, {
        kind: 'transfer', title: '结算转账', amount: t.amount,
        payerId: t.from, participantIds: [t.to], spentOn: today(),
      });
      toast('已记录还款');
      await renderLedger(root, state.token, { quiet: true });
    } catch (e) { toast(errMsg(e), true); }
  });
}

async function removeEntry(root, btn, e) {
  if (!confirm(`删除「${e.title}」${formatCents(e.amount)}？删除后无法恢复。`)) return;
  await withBusy(btn, async () => {
    try {
      await store.deleteEntry(state.token, e.id);
      toast('已删除');
      await renderLedger(root, state.token, { quiet: true });
    } catch (err) { toast(errMsg(err), true); }
  });
}

// ---------- 记一笔弹窗 ----------
const dialog = $('#entry-dialog');
const form = $('#entry-form');
const errEl = $('#entry-error');
let currentRoot = null;

function openEntryDialog(root) {
  currentRoot = root;
  form.reset();
  errEl.textContent = '';
  form.elements.spentOn.value = today();
  form.elements.spentOn.max = today();
  const payer = form.elements.payer;
  payer.replaceChildren(...state.members.map((m) => h('option', { value: m.id }, m.name)));
  $('#participants').replaceChildren(...state.members.map((m) =>
    h('label', { class: 'chip' }, h('input', { type: 'checkbox', name: 'participant', value: m.id, checked: true }), m.name)));
  shareInputs.replaceChildren();
  renderShareInputs();
  dialog.showModal();
  form.elements.title.focus();
}

// ---------- 分摊方式 ----------
const shareInputs = $('#share-inputs');
const preview = $('#split-preview');
const splitMode = () => form.querySelector('input[name=splitMode]:checked').value;
const checkedIds = () => [...form.querySelectorAll('input[name=participant]:checked')].map((b) => b.value);
const shareValues = (ids) => ids.map((id) => shareInputs.querySelector(`input[data-id="${id}"]`)?.value ?? '');

/** 按当前勾选的成员重建每人输入框；切换方式时清空已填的值，避免把比例误当金额 */
function renderShareInputs({ keep = true } = {}) {
  const mode = splitMode();
  shareInputs.hidden = mode === 'equal';
  const old = new Map(keep ? [...shareInputs.querySelectorAll('input')].map((i) => [i.dataset.id, i.value]) : []);
  shareInputs.replaceChildren(...(mode === 'equal' ? [] : checkedIds().map((id) => {
    const name = nameOf(id);
    return h('label', { class: 'share-row' }, h('span', {}, name),
      h('input', {
        'data-id': id, name: 'share', inputmode: mode === 'ratio' ? 'numeric' : 'decimal', autocomplete: 'off',
        'aria-label': `${name}的${mode === 'ratio' ? '份数' : '金额（元）'}`,
        placeholder: mode === 'ratio' ? '份数' : '0.00', value: old.get(id) ?? (mode === 'ratio' ? '1' : ''),
      }));
  })));
  updatePreview();
}

/** 实时提示：按比例时显示每人折算金额；按金额时显示与总额的差 */
function updatePreview() {
  const mode = splitMode();
  const amount = parseAmount(form.elements.amount.value);
  const ids = checkedIds();
  errEl.textContent = ''; // 用户已在修改，旧的提交报错不再准确
  preview.classList.remove('warn');
  preview.textContent = '';
  if (ids.length === 0 || amount == null) return;
  const r = parseSplit(mode, amount, shareValues(ids));
  if (!r.ok) { if (mode !== 'equal') { preview.textContent = r.error; preview.classList.add('warn'); } return; }
  const shares = entryShares(state.members, { amount, participantIds: ids, splitMode: mode, shares: r.shares });
  preview.textContent = mode === 'amount' ? '金额已对上 ✓' : shares.map(([id, c]) => `${nameOf(id)} ${formatCents(c)}`).join('，');
}

$('#split-mode').addEventListener('change', () => renderShareInputs({ keep: false }));
$('#participants').addEventListener('change', () => renderShareInputs());
shareInputs.addEventListener('input', updatePreview);
form.elements.amount.addEventListener('input', updatePreview);

$('#toggle-all').addEventListener('click', () => {
  const boxes = [...form.querySelectorAll('input[name=participant]')];
  const allOn = boxes.every((b) => b.checked);
  boxes.forEach((b) => { b.checked = !allOn; });
  renderShareInputs();
});
// 提交请求进行中不允许关闭弹窗（Esc 触发 cancel 事件；取消按钮在提交期间同样无效）
const submitting = () => $('#entry-submit').disabled;
// Chrome 连续两次 Esc 时第二次 cancel 不可取消，所以还要在 keydown 阶段拦截。
// 按钮 disabled 后焦点会落到 body，因此在 document 捕获阶段监听，而不是只监听 dialog。
dialog.addEventListener('cancel', (ev) => { if (submitting()) ev.preventDefault(); });
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && dialog.open && submitting()) ev.preventDefault();
}, true);
$('#entry-cancel').addEventListener('click', () => { if (!submitting()) dialog.close(); });

form.addEventListener('submit', (ev) => {
  ev.preventDefault();
  errEl.textContent = '';
  const title = form.elements.title.value.trim();
  const amount = parseAmount(form.elements.amount.value);
  const payerId = form.elements.payer.value;
  const participantIds = [...form.querySelectorAll('input[name=participant]:checked')].map((b) => b.value);
  const spentOn = form.elements.spentOn.value;
  if (!title) return void (errEl.textContent = '请填写内容');
  if (amount == null) return void (errEl.textContent = '金额格式不对，最多两位小数，且大于 0、不超过 1000 万');
  if (participantIds.length === 0) return void (errEl.textContent = '至少选择一位分摊成员');
  const mode = splitMode();
  const split = parseSplit(mode, amount, shareValues(participantIds));
  if (!split.ok) return void (errEl.textContent = split.error);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(spentOn) || spentOn > today()) return void (errEl.textContent = '请选择不晚于今天的日期');

  withBusy($('#entry-submit'), async () => {
    try {
      await store.addEntry(state.token, { kind: 'expense', title, amount, payerId, participantIds, spentOn, splitMode: mode, shares: split.shares });
      dialog.close();
      toast(`已记录 ${formatCents(amount)}`);
      await renderLedger(currentRoot, state.token, { quiet: true });
    } catch (e) { errEl.textContent = errMsg(e); }
  });
});
