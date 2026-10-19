// 端到端测试 + 截图（bypassCSP 仅用于让测试框架在页面内求值；站点 CSP 另由 curl 检查响应头）
//：本地静态服务器 + Chromium 手机视口（iPhone 12 尺寸）
// 运行：NODE_PATH=<workspace>/node_modules node tests/e2e.mjs [baseUrl]
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const root = fileURLToPath(new URL('../site/', import.meta.url));
const shots = fileURLToPath(new URL('../screenshots/', import.meta.url));
await mkdir(shots, { recursive: true });
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

let server;
let base = process.argv[2];
if (!base) {
  server = createServer(async (req, res) => {
    const p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([\\/])+/, '');
    const file = join(root, p || 'index.html');
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    // 本地运行默认用本机模式，不往线上数据库写测试数据；E2E_CLOUD=1 时沿用 config.js 连云端
    if (p.replace(/\\/g, '/') === 'js/config.js' && !process.env.E2E_CLOUD) {
      res.writeHead(200, { 'Content-Type': 'text/javascript' }).end("export const CONFIG = { supabaseUrl: '', supabaseAnonKey: '' };");
      return;
    }
    try { res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }).end(await readFile(file)); }
    catch { res.writeHead(404).end('not found'); }
  }).listen(0);
  base = `http://localhost:${server.address().port}/`;
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ bypassCSP: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'zh-CN' });
// 真实访问时 Netlify 注入的工具条会被站点 CSP 拦截；测试关闭了 CSP，所以这里手动屏蔽，保证截图和用户所见一致
await ctx.route('**/.netlify/scripts/**', (r) => r.abort());
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const injected = [];
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  // Netlify 在边缘注入的工具条（/.netlify/scripts/* 及其 srcdoc iframe）会被本站严格 CSP 拦截，属于预期行为，单独统计
  const src = m.location()?.url || '';
  if (src.includes('/.netlify/scripts/') || src === 'about:srcdoc' || (/Content Security Policy/.test(m.text()) && /netlify/.test(src))) injected.push(m.text());
  else errors.push(`${m.text()} @ ${src}`);
});
page.on('dialog', (d) => d.accept());
const ok = (cond, msg) => { if (!cond) throw new Error('断言失败：' + msg); console.log('✓', msg); };

await page.goto(base);
await page.screenshot({ path: shots + '1-home.png', fullPage: true });

// 校验：成员不足
await page.fill('input[name=ledgerName]', '502 合租');
await page.click('text=创建账本');
ok(await page.isVisible('text=至少需要 2 位成员'), '成员不足时提示');

const inputs = page.locator('input[name=member]');
await inputs.nth(1).fill('小王');
await inputs.nth(2).fill('小李');
await page.click('text=创建账本');
await page.waitForSelector('.ledger-head');
ok(/#\/l\/[0-9a-f]{32}$/.test(page.url()), '创建账本后跳转到带 128bit token 的链接');
const hideToast = () => page.evaluate(() => { document.querySelector('#toast').hidden = true; });

async function addExpense(title, amount, payerIdx, uncheck = []) {
  await page.click('.fab');
  await page.fill('input[name=title]', title);
  await page.fill('input[name=amount]', amount);
  await page.selectOption('select[name=payer]', { index: payerIdx });
  for (const i of uncheck) await page.locator('input[name=participant]').nth(i).uncheck();
  await page.click('#entry-submit');
  await page.locator('#entry-dialog').waitFor({ state: 'hidden', timeout: 15000 }).catch(async (e) => { throw new Error('弹窗未关闭：' + await page.textContent('#entry-error') + ' / ' + errors.join(' | ')); });
  await page.waitForFunction(() => !document.querySelector('#app').hasAttribute('aria-busy'));
}

// 异常输入
await page.click('.fab');
await page.fill('input[name=title]', '测试');
await page.fill('input[name=amount]', '12.345');
await page.click('#entry-submit');
ok((await page.textContent('#entry-error')).includes('金额格式不对'), '非法金额被拦截');
await page.fill('input[name=amount]', '10');
await page.click('#toggle-all');
await page.click('#entry-submit');
ok((await page.textContent('#entry-error')).includes('至少选择一位'), '无分摊人被拦截');
await hideToast();
await page.screenshot({ path: shots + '3-add-entry.png' });
// 提交进行中（保存按钮 disabled）按 Esc 或点取消都不能关闭弹窗；空闲时 Esc 可以关闭
await page.evaluate(() => { document.querySelector('#entry-submit').disabled = true; });
await page.keyboard.press('Escape');
await page.keyboard.press('Escape');
ok(await page.evaluate(() => document.querySelector('#entry-dialog').open), '提交中按 Esc 不会关闭弹窗');
await page.locator('#entry-cancel').click({ timeout: 5000 });
ok(await page.evaluate(() => document.querySelector('#entry-dialog').open), '提交中点取消不会关闭弹窗');
await page.evaluate(() => { document.querySelector('#entry-submit').disabled = false; });
await page.keyboard.press('Escape');
await page.locator('#entry-dialog').waitFor({ state: 'hidden', timeout: 3000 });
ok(true, '空闲时按 Esc 关闭弹窗');

await addExpense('10 月房租', '4500', 0);
await addExpense('电费', '186.4', 2);
await addExpense('火锅（小李没去）', '268', 1, [2]);
await page.waitForSelector('.transfer');
const settleText = await page.textContent('#settle');
ok(settleText.includes('笔就能结清'), '生成结算方案');
await hideToast();
await page.screenshot({ path: shots + '2-ledger.png' });
await page.screenshot({ path: shots + '2-ledger-full.png', fullPage: true });

// 刷新后数据仍在
await page.reload();
await page.waitForSelector('.entries');
ok(await page.locator('.entries li').count() === 3, '刷新后 3 条记录仍在（数据持久化）');

// 并发标记已还：另一个标签页先记了这笔还款，原页面再点同一笔时不应重复记账
// 同一浏览器上下文：本机模式共享 localStorage，云端模式共享服务端数据，两种模式都适用
{
  const p2 = await ctx.newPage();
  p2.on('dialog', (d) => d.accept());
  await p2.goto(page.url());
  await p2.waitForSelector('.transfer button');
  const n = await p2.locator('.transfer button').count();
  await p2.locator('.transfer button').first().click();
  await p2.waitForFunction((k) => document.querySelectorAll('.transfer button').length < k, n, { timeout: 15000 });
  await p2.close();
  await page.locator('.transfer button').first().click();
  await page.waitForSelector('#toast:not([hidden])');
  ok((await page.textContent('#toast')).includes('已被其他人更新'), '结算方案过时时提示已更新');
  await page.waitForFunction(() => !document.querySelector('#app').hasAttribute('aria-busy'));
  ok(await page.locator('.entries .tag').count() === 1, '并发标记已还不会重复记还款');
}

// 标记全部已还
// 云端模式下每次操作要等请求返回，按 aria-busy 判断刷新是否完成
const settled = () => page.waitForFunction(() => !document.querySelector('#app').hasAttribute('aria-busy') && !document.querySelector('.transfer button:disabled'));
while (await page.locator('.transfer button').count()) {
  const n = await page.locator('.transfer button').count();
  await page.locator('.transfer button').first().click();
  await page.waitForFunction((k) => document.querySelectorAll('.transfer button').length < k, n, { timeout: 15000 });
  await settled();
}
ok(await page.isVisible('text=账已经平了'), '全部标记已还后账目平衡');
await hideToast();
await page.screenshot({ path: shots + '4-settled.png' });

// 删除一条
const before = await page.locator('.entries li').count();
await page.locator('.entries li').first().locator('.icon-btn').click();
await page.waitForFunction((k) => document.querySelectorAll('.entries li').length === k - 1, before, { timeout: 15000 });
ok(true, '删除记录成功');

// 跨设备同步：全新的浏览器上下文（不共享 localStorage），打开同一链接并记一笔
const isCloudMode = (await page.textContent('#mode-badge')).includes('云端');
if (isCloudMode) {
  const ledgerUrl = page.url();
  const ctx2 = await browser.newContext({ bypassCSP: true, viewport: { width: 390, height: 844 }, isMobile: true, locale: 'zh-CN' });
  const p2 = await ctx2.newPage();
  p2.on('dialog', (d) => d.accept());
  await p2.goto(ledgerUrl);
  await p2.waitForSelector('.entries');
  ok(await p2.locator('.entries li').count() === await page.locator('.entries li').count(), '另一设备打开链接能看到相同流水');
  await p2.click('.fab');
  await p2.fill('input[name=title]', '另一台手机记的');
  await p2.fill('input[name=amount]', '30');
  await p2.click('#entry-submit');
  await p2.waitForFunction(() => !document.querySelector('#entry-dialog').open);
  await ctx2.close();
  await page.reload();
  await page.waitForSelector('.entries');
  ok((await page.textContent('.entries')).includes('另一台手机记的'), '原设备刷新后看到另一设备的新记录');
}

// #9 按比例 / 按金额分摊（新账本：我、小王、小李）
await page.goto(base);
await page.fill('input[name=ledgerName]', '云南五日游');
await page.locator('input[name=member]').nth(1).fill('小王');
await page.locator('input[name=member]').nth(2).fill('小李');
await page.click('text=创建账本');
await page.waitForSelector('.ledger-head');
await hideToast();
const pickMode = (label) => page.locator('#split-mode label', { hasText: label }).click();
const share = (i) => page.locator('#share-inputs input').nth(i);

// 按比例：房费 300，我 2 份、小王 1 份、小李 0 人（不参与）
await page.click('.fab');
await page.fill('input[name=title]', '民宿（按房间大小）');
await page.fill('input[name=amount]', '300');
await page.locator('input[name=participant]').nth(2).uncheck();
await pickMode('按比例');
ok(await page.locator('#share-inputs input').count() === 2, '按比例：只为勾选的成员显示份数输入框');
await share(0).fill('2');
ok((await page.textContent('#split-preview')).includes('我 ¥200.00，小王 ¥100.00'), '按比例：实时显示每人折算金额');
await page.click('#entry-submit');
await page.locator('#entry-dialog').waitFor({ state: 'hidden', timeout: 15000 });
await page.waitForFunction(() => !document.querySelector('#app').hasAttribute('aria-busy'));

// 按金额：聚餐 100，小王 30、小李 70，由小李付
await page.click('.fab');
await page.fill('input[name=title]', '晚饭（小王只喝饮料）');
await page.fill('input[name=amount]', '100');
await page.selectOption('select[name=payer]', { index: 2 });
await page.locator('input[name=participant]').nth(0).uncheck();
await pickMode('按金额');
await share(0).fill('30');
await share(1).fill('60');
ok((await page.textContent('#split-preview')).includes('还差 ¥10.00'), '按金额：合计不符时实时提示差额');
await page.click('#entry-submit');
ok((await page.textContent('#entry-error')).includes('还差'), '按金额：合计不符时不能保存');
await share(1).fill('70');
ok((await page.textContent('#entry-error')) === '', '修正金额后旧报错自动清除');
await hideToast();
await page.screenshot({ path: shots + '5-split.png' });
await page.click('#entry-submit');
await page.locator('#entry-dialog').waitFor({ state: 'hidden', timeout: 15000 });
await page.waitForFunction(() => !document.querySelector('#app').hasAttribute('aria-busy'));

// 我付 300（我 200 / 小王 100），小李付 100（小王 30 / 小李 70）
// → 我 +100，小王 -130，小李 +30
const balText = await page.textContent('#balances');
ok(balText.includes('我应收 ¥100.00') && balText.includes('小王应付 ¥130.00') && balText.includes('小李应收 ¥30.00'), '按比例 + 按金额：余额计算正确');
ok((await page.textContent('.entries')).includes('按金额：小王 ¥30.00、小李 ¥70.00'), '流水显示每人分摊金额');
await page.reload();
await page.waitForSelector('.entries');
ok((await page.textContent('#balances')).includes('小王应付 ¥130.00'), '刷新后分摊方式仍然保留');
// 切换方式后旧值被清空：防止把比例当成金额
await page.click('.fab');
await pickMode('按比例');
await share(0).fill('5');
await pickMode('按金额');
ok(await share(0).inputValue() === '', '切换分摊方式时清空已填的值');
await page.keyboard.press('Escape');
await hideToast();
await page.screenshot({ path: shots + '6-split-ledger.png', fullPage: true });

// #10 编辑支出：回填全部字段，改总额与每人金额
const busyDone = () => page.waitForFunction(() => !document.querySelector('#app').hasAttribute('aria-busy'));
await page.getByRole('button', { name: '编辑 晚饭（小王只喝饮料）' }).click();
ok(await page.textContent('#entry-dialog-title') === '编辑记录', '点击支出打开编辑弹窗');
ok(await page.inputValue('input[name=amount]') === '100.00' && await page.inputValue('select[name=payer]') !== ''
  && await page.locator('input[name=splitMode][value=amount]').isChecked(), '编辑：金额、付款人、分摊方式已回填');
ok(await share(0).inputValue() === '30.00' && await share(1).inputValue() === '70.00', '编辑：每人金额已回填');
ok(!(await page.locator('input[name=participant]').nth(0).isChecked()), '编辑：未参与的成员保持未勾选');
await page.fill('input[name=amount]', '120');
await share(0).fill('50');
ok((await page.textContent('#split-preview')).includes('金额已对上'), '编辑：修改后实时校验');
await hideToast();
await page.screenshot({ path: shots + '8-edit.png' });
await page.click('#entry-submit');
await page.locator('#entry-dialog').waitFor({ state: 'hidden', timeout: 15000 });
await busyDone();
// 我 +100，小王 -150，小李 +50
const bal2 = await page.textContent('#balances');
ok(bal2.includes('小王应付 ¥150.00') && bal2.includes('小李应收 ¥50.00'), '编辑后余额重新计算');
ok((await page.locator('.entries li', { hasText: '晚饭' }).textContent()).includes('已编辑'), '编辑过的记录显示"已编辑"');
await page.click('.fab');
ok(await page.textContent('#entry-dialog-title') === '记一笔' && await page.inputValue('input[name=amount]') === '', '编辑后再记一笔：表单恢复为新建状态');
await page.keyboard.press('Escape');

// 还款不能编辑：标记一笔已还，还款行没有编辑按钮
await page.locator('.transfer button').first().click();
await page.waitForSelector('.entries .tag:text("还款")');
await busyDone();
ok(await page.locator('.entries li', { hasText: '结算转账' }).locator('.entry-edit').count() === 0, '还款记录没有编辑入口');

// #10 成员管理：添加、余额未结清不能退出、退出、恢复、改名
await page.click('#open-members');
await page.fill('#member-add-form input[name=name]', '小张');
await page.click('#member-add');
await page.waitForSelector('#members-list li:has-text("小张")');
ok((await page.textContent('.ledger-head')).includes('4 人'), '添加成员后人数变为 4');
await page.getByRole('button', { name: '小王退出账本' }).click();
await page.waitForFunction(() => document.querySelector('#members-error').textContent.includes('未结清'));
ok(true, '余额未结清的成员不能退出');
await page.getByRole('button', { name: '小张退出账本' }).click();
await page.waitForSelector('#members-list li:has-text("小张") .muted-tag');
ok((await page.textContent('.ledger-head')).includes('3 人') && !(await page.textContent('#balances')).includes('小张'), '退出后人数减 1，余额列表不再显示');
await page.getByRole('button', { name: '给小李改名' }).click();
await page.fill('#members-list .rename-form input', '小王');
await page.click('#members-list .rename-form button[type=submit]');
ok((await page.textContent('#members-error')).includes('同名'), '改名为已有名字时报错');
await page.fill('#members-list .rename-form input', '李雷');
await page.click('#members-list .rename-form button[type=submit]');
await page.waitForSelector('#members-list li:has-text("李雷")');
await busyDone();
ok((await page.textContent('.entries')).includes('李雷') && !(await page.textContent('.entries')).includes('小李'), '改名后历史流水同步显示新名字');
ok((await page.textContent('#members-error')) === '', '改名成功后旧报错清除');
await hideToast();
await page.screenshot({ path: shots + '7-members.png' });
await page.click('#members-close');
await page.click('.fab');
ok(!(await page.textContent('#participants')).includes('小张')
  && !(await page.locator('select[name=payer] option', { hasText: '小张' }).count()), '记一笔不再列出已退出成员');
await page.keyboard.press('Escape');
await page.click('#open-members');
await page.getByRole('button', { name: '恢复小张' }).click();
await page.waitForFunction(() => !document.querySelector('#members-list li .muted-tag'));
await busyDone();
ok((await page.textContent('.ledger-head')).includes('4 人'), '恢复已退出成员');
await page.click('#members-close');
await page.reload();
await page.waitForSelector('.entries');
ok((await page.textContent('#balances')).includes('李雷') && (await page.textContent('.ledger-head')).includes('4 人'), '刷新后成员变更仍然保留');

// 无效链接
await page.goto(base + '#/l/abc');
ok(await page.isVisible('text=链接无效'), '无效链接有友好提示');
await page.goto(base + '#/l/' + 'f'.repeat(32));
await page.waitForSelector('text=打不开这个账本');
ok(true, '不存在的账本有友好提示');

// XSS：恶意成员名/账本名只能作为文本显示
await page.goto(base);
await page.fill('input[name=ledgerName]', '<svg onload=alert(1)>');
await page.locator('input[name=member]').nth(1).fill('<img src=x onerror=alert(1)>');
await page.click('text=创建账本');
await page.waitForSelector('.ledger-head');
ok(await page.locator('img[src=x], svg[onload]').count() === 0, 'XSS 载荷被当作纯文本渲染');

// 移动端无横向滚动；首页无 "null"/"undefined" 文本泄漏
await page.evaluate(() => localStorage.clear());
await page.goto(base);
await page.reload();
ok(!/\bnull\b|\bundefined\b/.test(await page.textContent('#app')), '页面无 null/undefined 文本');
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
ok(!overflow, '390px 手机宽度无横向溢出');

// 预期内的业务错误：前端已记录 [load]/[rpc] 日志；PostgREST 对数据库 raise exception 返回非 2xx，浏览器会打印资源加载失败
const unexpected = errors.filter((e) => !e.includes('[load]') && !e.includes('[rpc]')
  && !(/Failed to load resource/.test(e) && e.includes('.supabase.co/rest/v1/rpc/')));
ok(unexpected.length === 0, '无未处理的 JS 错误 ' + unexpected.join(' | '));
if (injected.length) console.log(`  （CSP 拦截了 ${injected.length} 次 Netlify 注入脚本，符合预期）`);

await browser.close();
server?.close();
console.log('\n全部通过');
