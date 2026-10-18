// 端到端测试 + 截图：本地静态服务器 + Chromium 手机视口（iPhone 12 尺寸）
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
    try { res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }).end(await readFile(file)); }
    catch { res.writeHead(404).end('not found'); }
  }).listen(0);
  base = `http://localhost:${server.address().port}/`;
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'zh-CN' });
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
  await page.waitForSelector('dialog[open]', { state: 'detached', timeout: 3000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('#entry-dialog').open);
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
await page.click('#entry-cancel');

await addExpense('10 月房租', '4500', 0);
await addExpense('电费', '186.4', 2);
await addExpense('火锅（小李没去）', '268', 1, [2]);
await page.waitForSelector('.transfer');
const settleText = await page.textContent('.card:nth-of-type(2)');
ok(settleText.includes('笔就能结清'), '生成结算方案');
await hideToast();
await page.screenshot({ path: shots + '2-ledger.png' });
await page.screenshot({ path: shots + '2-ledger-full.png', fullPage: true });

// 刷新后数据仍在
await page.reload();
await page.waitForSelector('.entries');
ok(await page.locator('.entries li').count() === 3, '刷新后 3 条记录仍在（数据持久化）');

// 标记全部已还
while (await page.locator('.transfer button').count()) {
  const n = await page.locator('.transfer button').count();
  await page.locator('.transfer button').first().click();
  await page.waitForFunction((k) => document.querySelectorAll('.transfer button').length < k, n);
}
ok(await page.isVisible('text=账已经平了'), '全部标记已还后账目平衡');
await hideToast();
await page.screenshot({ path: shots + '4-settled.png' });

// 删除一条
const before = await page.locator('.entries li').count();
await page.locator('.entries li').first().locator('.icon-btn').click();
await page.waitForFunction((k) => document.querySelectorAll('.entries li').length === k - 1, before);
ok(true, '删除记录成功');

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

const unexpected = errors.filter((e) => !e.includes('[load]') && !e.includes('[rpc]'));
ok(unexpected.length === 0, '无未处理的 JS 错误 ' + unexpected.join(' | '));
if (injected.length) console.log(`  （CSP 拦截了 ${injected.length} 次 Netlify 注入脚本，符合预期）`);

await browser.close();
server?.close();
console.log('\n全部通过');
