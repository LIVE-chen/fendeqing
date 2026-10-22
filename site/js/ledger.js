import {
  parseAmount, formatCents, computeBalances, minimizeTransfers, parseSplit, entryShares,
  centsToInput, canLeave, isActive, validateMemberName, describeActivity, dueDates,
  CURRENCIES, currencyName, parseForeign, parseRate, rateToInput, fxToCents, formatForeign, MAX_AMOUNT_CENTS,
} from './settle.js';
import { monthlyTotals, memberStats, barPercents, ledgerSheets, exportFileName } from './stats.js';
import { buildXlsx } from './xlsx.js';
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
    // 先补记到期的周期账单；失败（例如数据库还没升级）不影响打开账本
    // 操作后的静默刷新跳过这一步，少一次请求（新建周期账单时服务端已经补记过）
    let added = 0;
    if (!quiet) try { added = await store.runRecurring(token); } catch (e) { console.warn('[recurring]', e); }
    const data = await store.getLedger(token);
    if (!isCurrent(seq, token)) return;
    state = { token, ...data, recurring: data.recurring ?? [], today: data.today ?? today() };
    rememberLedger(token, data.name);
    paint(root);
    root.removeAttribute('aria-busy');
    if (added > 0) toast(`已自动记入 ${added} 笔周期账单`);
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

const memberOf = (id) => state.members.find((m) => m.id === id);
const nameOf = (id) => memberOf(id)?.name ?? '已删除成员';
const active = () => state.members.filter(isActive);
/** 参与人恰好是全部在账成员时显示"全员" */
const isEveryone = (ids) => {
  const a = active();
  return ids.length === a.length && a.every((m) => ids.includes(m.id));
};

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
      h('p', { class: 'muted' }, `${active().length} 人 · 共 ${expenses.length} 笔支出 · 合计 ${formatCents(total)}`)),
    h('div', { class: 'actions wrap' },
      h('button', { class: 'btn ghost', onclick: () => copyLink(shareUrl) }, isCloud ? '复制邀请链接' : '复制链接'),
      h('button', { class: 'btn ghost', id: 'open-members', onclick: () => openMembersDialog(root) }, '成员'),
      h('button', { class: 'btn ghost', id: 'open-history', onclick: () => openHistoryDialog(root) }, '历史'),
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
    // 已退出且已结清的成员不再显示；退出时余额必须为 0，但删除/编辑旧记录后可能重新出现余额
    h('ul', { class: 'list' }, state.members.filter((m) => isActive(m) || (balances.get(m.id) ?? 0) !== 0).map((m) => {
      const v = balances.get(m.id) ?? 0;
      return h('li', {},
        h('span', {}, m.name, isActive(m) ? null : h('span', { class: 'tag muted-tag' }, '已退出')),
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
            : `${isEveryone(e.participantIds) ? '全员' : e.participantIds.map(nameOf).join('、')} 分摊`;
          const sub = isT
            ? `${nameOf(e.payerId)} 还给 ${nameOf(e.participantIds[0])}`
            : `${nameOf(e.payerId)} 付款 · ${weighted ? (e.splitMode === 'ratio' ? '按比例：' : '按金额：') : ''}${who}`;
          const body = [
            h('div', { class: 'entry-title' }, isT ? h('span', { class: 'tag' }, '还款') : null, e.title,
              e.recurringId ? h('span', { class: 'tag muted-tag' }, '每月') : null,
              e.updatedAt ? h('span', { class: 'tag muted-tag' }, '已编辑') : null),
            h('div', { class: 'muted small' }, `${e.spentOn} · ${sub}`)];
          // 支出整块可点击编辑；还款只能删除
          return h('li', {},
            isT ? h('div', { class: 'entry-main' }, body)
              : h('button', { type: 'button', class: 'entry-main entry-edit', 'aria-label': `编辑 ${e.title}`, onclick: () => openEntryDialog(root, e) }, body),
            h('span', { class: 'amount' }, formatCents(e.amount),
              e.currency ? h('span', { class: 'muted small fx-orig' }, formatForeign(e.origAmount, e.currency)) : null),
            h('button', { class: 'icon-btn', 'aria-label': `删除 ${e.title}`, onclick: (ev) => removeEntry(root, ev.currentTarget, e) }, '×'));
        })));

  const fab = h('button', { class: 'fab', onclick: () => openEntryDialog(root) }, '+ 记一笔');
  root.replaceChildren(...[header, settle, balanceList, recurringCard(root), statsCard(), entryList, fab].filter(Boolean));
}

// ---------- 周期账单 ----------
const dayText = (dom, short = false) => (dom < 29 ? `每月 ${dom} 号`
  : short ? `每月 ${dom} 号（无此日记月底）` : `每月 ${dom} 号（没有这天的月份记在月底）`);

/** 没有周期账单时不显示卡片，入口在"记一笔"弹窗里 */
function recurringCard(root) {
  if (state.recurring.length === 0) return null;
  const paused = state.entries.length >= 2000 && state.recurring.some((r) => r.nextOn <= state.today);
  return h('section', { class: 'card', id: 'recurring' },
    h('h2', {}, '周期账单'),
    h('ul', { class: 'list' }, state.recurring.map((r) => h('li', {},
      h('div', { class: 'entry-main' },
        h('div', { class: 'entry-title' }, r.title),
        h('div', { class: 'muted small' }, `${dayText(r.dayOfMonth, true)} · ${nameOf(r.payerId)} 付款`),
        h('div', { class: 'muted small' }, `下次 ${r.nextOn}`)),
      h('span', { class: 'amount' }, formatCents(r.amount)),
      h('button', { class: 'icon-btn', 'aria-label': `删除周期账单 ${r.title}`, onclick: (ev) => removeRecurring(root, ev.currentTarget, r) }, '×')))),
    paused ? h('p', { class: 'hint warn' }, '账本已满 2000 条记录，周期账单暂停自动记账，删除一些旧记录后会继续补记。')
      : h('p', { class: 'hint' }, '到期后打开账本时自动记入流水，可以像普通支出一样编辑或删除。'));
}

async function removeRecurring(root, btn, r) {
  if (!confirm(`删除周期账单「${r.title}」？以后不再自动记账，已经记下的流水会保留。`)) return;
  await withBusy(btn, async () => {
    try {
      await store.deleteRecurring(state.token, r.id);
      toast('已删除周期账单');
      await renderLedger(root, state.token, { quiet: true });
    } catch (e) { toast(errMsg(e), true); }
  });
}

// ---------- 统计与导出 ----------
/** 条形图：配文字数值，读屏软件读到的是文字而不是图形 */
function bars(rows, cls = '') {
  const pct = barPercents(rows.map((r) => r.value));
  return h('ul', { class: `bars ${cls}` }, rows.map((r, i) => {
    const fill = h('span', { class: 'bar-fill' });
    fill.style.width = `${pct[i]}%`; // 用 CSSOM 设置：站点 CSP 禁止内联 style 属性，但允许脚本改样式
    return h('li', {},
      h('span', { class: 'bar-label' }, r.label),
      h('span', { class: 'bar-track', 'aria-hidden': 'true' }, fill),
      h('span', { class: 'amount small' }, formatCents(r.value)));
  }));
}

function statsCard() {
  const months = monthlyTotals(state.entries);
  const per = memberStats(state.members, state.entries);
  const label = (s) => (s.left ? `${s.name}（已退出）` : s.name);
  return h('section', { class: 'card', id: 'stats' },
    h('div', { class: 'card-head' }, h('h2', {}, '统计'),
      h('button', { class: 'btn small', id: 'export-xlsx', onclick: (ev) => exportXlsx(ev.currentTarget) }, '导出 Excel')),
    months.length === 0
      ? h('p', { class: 'muted' }, '记几笔支出后，这里会显示每月花销和每人实际消费。')
      : [
          h('h3', {}, '每月支出'),
          bars(months.slice(0, 12).map((m) => ({ label: m.month, value: m.total }))),
          months.length > 12 ? h('p', { class: 'hint' }, `只显示最近 12 个月，完整数据请导出 Excel`) : null,
          h('h3', {}, '每人实际消费'),
          h('p', { class: 'hint' }, '按分摊算出的每人花销，不含还款。'),
          bars(per.map((s) => ({ label: label(s), value: s.share })), 'per-member'),
        ]);
}

function exportXlsx(btn) {
  withBusy(btn, async () => {
    try {
      const data = await store.getLedger(state.token); // 导出最新数据
      const bytes = buildXlsx(ledgerSheets(data));
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const a = h('a', { href: url, download: exportFileName(data.name, today()) });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      toast('已导出 Excel');
    } catch (e) { console.error('[export]', e); toast(errMsg(e), true); }
  });
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
  if (!confirm(`删除「${e.title}」${formatCents(e.amount)}？30 天内可以在"历史"里恢复。`)) return;
  await withBusy(btn, async () => {
    try {
      await store.deleteEntry(state.token, e.id);
      await renderLedger(root, state.token, { quiet: true });
      toast('已删除', false, { label: '撤销', onClick: () => restoreEntry(root, e.id) });
    } catch (err) { toast(errMsg(err), true); }
  });
}

async function restoreEntry(root, id) {
  try {
    await store.restoreEntry(state.token, id);
    toast('已恢复');
    await renderLedger(root, state.token, { quiet: true });
    return true;
  } catch (err) { toast(errMsg(err), true); return false; }
}

// ---------- 记一笔弹窗 ----------
const dialog = $('#entry-dialog');
const form = $('#entry-form');
const errEl = $('#entry-error');
let currentRoot = null;
let editing = null; // 正在编辑的支出；null 表示新记一笔

/** entry 不为空时进入编辑模式，回填全部字段 */
function openEntryDialog(root, entry = null) {
  currentRoot = root;
  editing = entry;
  form.reset();
  errEl.textContent = '';
  $('#entry-dialog-title').textContent = entry ? '编辑记录' : '记一笔';
  form.elements.spentOn.max = today();
  // 只列在账成员；编辑时额外列出原记录里已退出的人，允许保留
  const keepIds = entry ? [entry.payerId, ...entry.participantIds] : [];
  const choices = state.members.filter((m) => isActive(m) || keepIds.includes(m.id));
  const label = (m) => (isActive(m) ? m.name : `${m.name}（已退出）`);
  form.elements.payer.replaceChildren(...choices.map((m) => h('option', { value: m.id }, label(m))));
  const checked = new Set(entry ? entry.participantIds : choices.map((m) => m.id));
  $('#participants').replaceChildren(...choices.map((m) =>
    h('label', { class: 'chip' }, h('input', { type: 'checkbox', name: 'participant', value: m.id, checked: checked.has(m.id) }), label(m))));
  shareInputs.replaceChildren();
  $('#repeat-row').hidden = Boolean(entry); // 只有新记一笔时可以设为每月重复
  form.elements.currency.value = entry?.currency ?? 'CNY';
  updateCurrency({ fillRate: false });
  if (entry?.currency) form.elements.fxRate.value = rateToInput(entry.fxRate);
  updateRepeat();
  if (entry) {
    form.elements.title.value = entry.title;
    form.elements.amount.value = entry.currency ? centsToInput(entry.origAmount) : centsToInput(entry.amount);
    form.elements.payer.value = entry.payerId;
    form.elements.spentOn.value = entry.spentOn;
    const mode = entry.splitMode === 'ratio' || entry.splitMode === 'amount' ? entry.splitMode : 'equal';
    form.querySelector(`input[name=splitMode][value=${mode}]`).checked = true;
    renderShareInputs({ keep: false });
    if (mode !== 'equal' && Array.isArray(entry.shares)) {
      entry.participantIds.forEach((id, k) => {
        const input = shareInputs.querySelector(`input[data-id="${id}"]`);
        if (input) input.value = mode === 'amount' ? centsToInput(entry.shares[k]) : String(entry.shares[k]);
      });
      updatePreview();
    }
  } else {
    form.elements.spentOn.value = today();
    renderShareInputs();
  }
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
  const { amount } = readAmount();
  updateFxPreview();
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

// ---------- 每月重复 ----------
const repeatBox = $('#repeat');
const repeatHint = $('#repeat-hint');
const shiftDays = (iso, n) => new Date(Date.parse(iso) + n * 86400_000).toISOString().slice(0, 10);
const repeatRange = () => ({ min: shiftDays(state.today, -365), max: shiftDays(state.today, 365) });

/** 勾选后日期变为"首次记账日期"，允许选一年内的未来日期 */
function updateRepeat() {
  const on = repeatBox.checked && !editing;
  const { min, max } = repeatRange();
  form.elements.spentOn.min = on ? min : '';
  form.elements.spentOn.max = on ? max : today();
  const d = form.elements.spentOn.value;
  if (!on || !/^\d{4}-\d{2}-\d{2}$/.test(d)) { repeatHint.textContent = ''; return; }
  const dom = Number(d.slice(8, 10));
  repeatHint.textContent = d <= state.today
    ? `${dayText(dom)}自动记一笔；从 ${d} 起到今天的 ${dueCount(d, dom)} 笔会立即补记。`
    : `${dayText(dom)}自动记一笔，第一笔在 ${d}。`;
}
const dueCount = (d, dom) => dueDates(d, dom, state.today, 13).dates.length;
repeatBox.addEventListener('change', updateRepeat);
form.elements.spentOn.addEventListener('input', updateRepeat);

// ---------- 币种（#13）：汇率由用户填写，余额与结算一律按折合后的人民币计算 ----------
const curSel = form.elements.currency;
curSel.replaceChildren(...CURRENCIES.map(([c, name]) => h('option', { value: c }, c === 'CNY' ? '人民币' : `${name} ${c}`)));
const fxPreview = $('#fx-preview');
const FX_HINT = '汇率请自己填写（可参考银行或支付软件的当日汇率），本应用不联网查询。';
const isForeign = () => curSel.value !== 'CNY';

/** 读取金额：人民币直接解析；外币按 原币 × 汇率 折算。返回 { amount, fx, error } */
function readAmount() {
  if (!isForeign()) {
    const amount = parseAmount(form.elements.amount.value);
    return amount == null ? { error: '金额格式不对，最多两位小数，且大于 0、不超过 1000 万' } : { amount, fx: null };
  }
  const orig = parseForeign(form.elements.amount.value);
  if (orig == null) return { error: '外币金额格式不对，最多两位小数，且大于 0' };
  const rate = parseRate(form.elements.fxRate.value);
  if (rate == null) return { error: '请填写汇率：大于 0、不超过 1000，最多 6 位小数' };
  const amount = fxToCents(orig, rate);
  if (amount < 1 || amount > MAX_AMOUNT_CENTS) return { error: '折合人民币需大于 0 且不超过 1000 万' };
  return { amount, fx: { currency: curSel.value, origAmount: orig, fxRate: rate } };
}

function updateFxPreview() {
  if (!isForeign()) return;
  const r = readAmount();
  fxPreview.textContent = r.fx ? `${formatForeign(r.fx.origAmount, r.fx.currency)} ≈ ${formatCents(r.amount)}（1 ${r.fx.currency} = ${rateToInput(r.fx.fxRate)} 元）` : FX_HINT;
}

/** 切换币种：外币时显示汇率，不支持按金额分摊和每月重复；fillRate 时用本账本最近一次该币种的汇率预填 */
function updateCurrency({ fillRate = true } = {}) {
  const foreign = isForeign();
  $('#fx-row').hidden = !foreign;
  $('#amount-label').textContent = foreign ? `金额（${currencyName(curSel.value)}）` : '金额（元）';
  $('#rate-label').textContent = foreign ? `汇率：1 ${curSel.value} = ? 元` : '汇率';
  const amountRadio = form.querySelector('input[name=splitMode][value=amount]');
  amountRadio.disabled = foreign;
  if (foreign && amountRadio.checked) { form.querySelector('input[name=splitMode][value=equal]').checked = true; renderShareInputs({ keep: false }); }
  if (foreign) { repeatBox.checked = false; updateRepeat(); }
  repeatBox.disabled = foreign;
  if (fillRate) {
    const last = state.entries.find((e) => e.currency === curSel.value);
    form.elements.fxRate.value = last ? rateToInput(last.fxRate) : '';
  }
  fxPreview.textContent = FX_HINT;
  updatePreview();
}
curSel.addEventListener('change', () => updateCurrency());
form.elements.fxRate.addEventListener('input', updatePreview);

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
  const { amount, fx, error: amountErr } = readAmount();
  const payerId = form.elements.payer.value;
  const participantIds = [...form.querySelectorAll('input[name=participant]:checked')].map((b) => b.value);
  const spentOn = form.elements.spentOn.value;
  if (!title) return void (errEl.textContent = '请填写内容');
  if (amountErr) return void (errEl.textContent = amountErr);
  if (participantIds.length === 0) return void (errEl.textContent = '至少选择一位分摊成员');
  const mode = splitMode();
  const split = parseSplit(mode, amount, shareValues(participantIds));
  if (!split.ok) return void (errEl.textContent = split.error);
  const repeat = repeatBox.checked && !editing;
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(spentOn);
  if (repeat) {
    const { min, max } = repeatRange();
    if (!valid || spentOn < min || spentOn > max) return void (errEl.textContent = '首次日期需在前后一年内');
  } else if (!valid || spentOn > today()) return void (errEl.textContent = '请选择不晚于今天的日期');

  withBusy($('#entry-submit'), async () => {
    try {
      const e = { kind: 'expense', title, amount, payerId, participantIds, spentOn, splitMode: mode, shares: split.shares, ...fx };
      let msg;
      if (repeat) {
        const { added } = await store.addRecurring(state.token, { ...e, startOn: spentOn });
        msg = added > 0 ? `已设为每月重复，补记了 ${added} 笔` : `已设为每月重复，${spentOn} 记第一笔`;
      } else if (editing) {
        await store.updateEntry(state.token, editing.id, e);
        msg = '已保存修改';
      } else {
        await store.addEntry(state.token, e);
        msg = fx ? `已记录 ${formatForeign(fx.origAmount, fx.currency)}，折合 ${formatCents(amount)}` : `已记录 ${formatCents(amount)}`;
      }
      dialog.close();
      toast(msg);
      await renderLedger(currentRoot, state.token, { quiet: true });
    } catch (e) { errEl.textContent = errMsg(e); }
  });
});

// ---------- 成员管理弹窗 ----------
const mDialog = $('#members-dialog');
const mList = $('#members-list');
const mErr = $('#members-error');
const mAddForm = $('#member-add-form');
let mRoot = null;

function openMembersDialog(root) {
  mRoot = root;
  mErr.textContent = '';
  mAddForm.reset();
  renderMembers();
  mDialog.showModal();
}

/** 操作成功后刷新账本，再重画成员列表（state 已更新） */
async function afterMemberChange(msg) {
  mErr.textContent = '';
  toast(msg);
  await renderLedger(mRoot, state.token, { quiet: true });
  if (mDialog.open) renderMembers();
}

function renderMembers() {
  const balances = computeBalances(state.members, state.entries);
  const sorted = [...active(), ...state.members.filter((m) => !isActive(m))];
  mList.replaceChildren(...sorted.map((m) => {
    const name = h('span', { class: 'member-name' }, m.name, isActive(m) ? null : h('span', { class: 'tag muted-tag' }, '已退出'));
    const actions = isActive(m)
      ? [h('button', { type: 'button', class: 'btn small ghost', 'aria-label': `给${m.name}改名`, onclick: () => startRename(li, m) }, '改名'),
         h('button', { type: 'button', class: 'btn small ghost', 'aria-label': `${m.name}退出账本`, onclick: (ev) => leave(ev.currentTarget, m.id) }, '退出')]
      : [h('button', { type: 'button', class: 'btn small ghost', 'aria-label': `恢复${m.name}`, onclick: (ev) => restore(ev.currentTarget, m.name) }, '恢复')];
    const v = balances.get(m.id) ?? 0;
    const li = h('li', { class: 'member-row' }, name,
      v ? h('span', { class: `amount small ${v > 0 ? 'pos' : 'neg'}` }, v > 0 ? `应收 ${formatCents(v)}` : `应付 ${formatCents(-v)}`) : null,
      h('span', { class: 'actions' }, actions));
    return li;
  }));
}

function startRename(li, m) {
  mErr.textContent = '';
  const input = h('input', { value: m.name, maxlength: '20', 'aria-label': `${m.name}的新名字`, autocomplete: 'off' });
  const save = h('button', { type: 'submit', class: 'btn small primary' }, '保存');
  const f = h('form', { class: 'rename-form', novalidate: true }, input, save,
    h('button', { type: 'button', class: 'btn small ghost', onclick: () => renderMembers() }, '取消'));
  f.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const r = validateMemberName(input.value, state.members.filter((x) => x.id !== m.id).map((x) => x.name));
    if (!r.ok) return void (mErr.textContent = r.error);
    if (r.name === m.name) return renderMembers();
    withBusy(save, async () => {
      try { await store.renameMember(state.token, m.id, r.name); await afterMemberChange('已改名'); }
      catch (e) { mErr.textContent = errMsg(e); }
    });
  });
  li.replaceChildren(f);
  input.focus();
  input.select();
}

async function leave(btn, id) {
  mErr.textContent = '';
  await withBusy(btn, async () => {
    try {
      // 用最新数据判断是否已结清，避免别的设备刚记了一笔
      const latest = await store.getLedger(state.token);
      // 先查周期账单：结清后周期账单还会继续产生新的欠款，所以要先处理它
      const inRec = (latest.recurring ?? []).filter((x) => x.payerId === id || x.participantIds.includes(id));
      if (inRec.length) {
        mErr.textContent = `该成员还在周期账单「${inRec.map((x) => x.title).join('」「')}」里，请先删除相关的周期账单`;
        return;
      }
      const r = canLeave(latest.members, computeBalances(latest.members, latest.entries), id);
      if (!r.ok) { mErr.textContent = r.error; return; }
      const name = latest.members.find((m) => m.id === id).name;
      if (!confirm(`${name}退出账本？历史记录会保留，之后可以随时恢复。`)) return;
      await store.leaveMember(state.token, id);
      await afterMemberChange(`${name}已退出`);
    } catch (e) { mErr.textContent = errMsg(e); }
  });
}

async function restore(btn, name) {
  mErr.textContent = '';
  await withBusy(btn, async () => {
    try { await store.addMember(state.token, name); await afterMemberChange(`${name}已恢复`); }
    catch (e) { mErr.textContent = errMsg(e); }
  });
}

mAddForm.addEventListener('submit', (ev) => {
  ev.preventDefault();
  mErr.textContent = '';
  // 与已退出成员同名属于"恢复"，允许；与在账成员同名才报错
  const r = validateMemberName(mAddForm.elements.name.value, active().map((m) => m.name));
  if (!r.ok) return void (mErr.textContent = r.error);
  if (active().length >= 20) return void (mErr.textContent = '最多 20 位成员');
  const revived = state.members.some((m) => m.name === r.name);
  withBusy($('#member-add'), async () => {
    try {
      await store.addMember(state.token, r.name);
      mAddForm.reset();
      await afterMemberChange(revived ? `${r.name}已恢复` : `已添加${r.name}`);
    } catch (e) { mErr.textContent = errMsg(e); }
  });
});
$('#members-close').addEventListener('click', () => mDialog.close());

// ---------- 历史弹窗：最近删除（可恢复）+ 操作记录 ----------
const hDialog = $('#history-dialog');
const hDeleted = $('#history-deleted');
const hLog = $('#history-log');
let hRoot = null;

const fmtTime = (iso) => {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return Number.isNaN(d.getTime()) ? '' : `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

async function openHistoryDialog(root) {
  hRoot = root;
  hDeleted.replaceChildren(h('li', { class: 'muted' }, '加载中…'));
  hLog.replaceChildren();
  hDialog.showModal();
  await loadHistory();
}

async function loadHistory() {
  try {
    const { deleted, activities } = await store.getHistory(state.token);
    if (!hDialog.open) return;
    hDeleted.replaceChildren(...(deleted.length ? deleted.map((e) => h('li', {},
      h('div', { class: 'entry-main' },
        h('div', { class: 'entry-title' }, e.kind === 'transfer' ? h('span', { class: 'tag' }, '还款') : null, e.title),
        h('div', { class: 'muted small' }, `${e.spentOn} · ${nameOf(e.payerId)} ${e.kind === 'transfer' ? '还款' : '付款'} · 删除于 ${fmtTime(e.deletedAt)}`)),
      h('span', { class: 'amount' }, formatCents(e.amount),
        e.currency ? h('span', { class: 'muted small fx-orig' }, formatForeign(e.origAmount, e.currency)) : null),
      h('button', {
        type: 'button', class: 'btn small', 'aria-label': `恢复 ${e.title}`,
        onclick: (ev) => withBusy(ev.currentTarget, async () => { if (await restoreEntry(hRoot, e.id)) await loadHistory(); }),
      }, '恢复'))) : [h('li', { class: 'muted' }, '30 天内没有删除过记录')]));
    hLog.replaceChildren(...(activities.length ? activities.map((a) => h('li', {},
      h('span', { class: 'log-text' }, describeActivity(a)),
      h('time', { class: 'muted small', datetime: a.at }, fmtTime(a.at)))) : [h('li', { class: 'muted' }, '暂无记录')]));
  } catch (e) {
    console.error('[history]', e);
    hDeleted.replaceChildren(h('li', { class: 'form-error' }, errMsg(e)));
  }
}
$('#history-close').addEventListener('click', () => hDialog.close());
