// detail5-probe.mjs —— 坐标点击首条帖子进详情（不依赖标题匹配）
//
// 前面失败原因：站点把首页分页位置存在 localStorage（HJHotPages），
// 页面渲染的可能是第 4 页，而样本来自 page=1，标题对不上 → no-leaf。
// 这里改成：清掉 localStorage 让首页回到第 1 页，然后按坐标依次点首条帖子的几个位置，
// 每次检查 URL 是否变成详情页；一旦命中就 dump 全部 /api/ 响应。

import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const OUT = 'out12';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
           '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const BASE = 'https://haijiao.com';
const BLOCK = [
  '**/api/banner/banner_list*', '**/hjstore/system/banner/**',
  '**/www.google-analytics.com/**', '**/www.googletagmanager.com/**',
  '**/static.cloudflareinsights.com/**',
];

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'] });
  const ctx = await browser.newContext({
    userAgent: UA, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
    isMobile: true, hasTouch: true, locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
  });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  const page = await ctx.newPage();
  for (const p of BLOCK) await page.route(p, r => r.abort());

  const apiLog = [];
  const saved = [];
  let n = 0;
  page.on('request', r => {
    const u = r.url();
    if (u.includes('/api/')) apiLog.push({ m: r.method(), u: u.replace(BASE, ''), body: (r.postData() || '').slice(0, 300) });
  });
  page.on('response', async r => {
    const u = r.url();
    if (!/\/api\//.test(u)) return;
    try {
      const t = await r.text();
      if (t.length < 20) return;
      const name = `${String(++n).padStart(2, '0')}-${u.replace(BASE, '').replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 46)}.json`;
      await fs.mkdir(path.join(OUT, 'bodies'), { recursive: true });
      await fs.writeFile(path.join(OUT, 'bodies', name), t.slice(0, 120000));
      saved.push({ url: u.replace(BASE, ''), status: r.status(), file: name, len: t.length });
    } catch (e) {}
  });

  await page.goto(`${BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);

  // 清掉分页记忆 → 重新加载 → 首条帖子就是 API 的第 1 页第 1 条
  await page.evaluate(() => { try { localStorage.removeItem('HJHotPages'); localStorage.removeItem('RouterVer'); } catch (e) {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  const before = page.url();
  const tried = [];
  const ys = [300, 360, 420, 480, 540, 620];
  let entered = false;
  for (const y of ys) {
    await page.mouse.click(195, y);
    await page.waitForTimeout(2200);
    const now = page.url();
    tried.push({ y, url: now.replace(BASE, '') });
    if (now !== before) { entered = true; break; }
  }

  const after = await page.evaluate(() => {
    const t = (document.body && document.body.innerText || '').replace(/\s+/g, ' ');
    return { url: location.href, len: t.length, head: t.slice(0, 240) };
  });

  if (entered) {
    await page.waitForTimeout(4000);
    await page.evaluate(() => window.scrollBy(0, 1500));   // 触发评论/分页加载
    await page.waitForTimeout(3000);
    await page.screenshot({ path: path.join(OUT, 'detail.png'), fullPage: false });
  }

  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, 'detail5.json'), JSON.stringify({
    entered, tried, after, apiLog, saved,
  }, null, 2));

  console.log('进入详情:', entered);
  console.log('详情 URL:', after.url);
  console.log('文本长度:', after.len);
  console.log('开头:', after.head.slice(0, 160));
  console.log(`\nAPI ${apiLog.length} 条：`);
  for (const a of apiLog.slice(0, 25)) console.log(`  ${a.m} ${a.u}`);
  console.log(`\n保存响应 ${saved.length} 个：`);
  for (const s of saved.slice(0, 15)) console.log(`  ${s.status} ${s.url.slice(0, 60)} -> ${s.file}`);
  await browser.close();
}

await fs.mkdir(OUT, { recursive: true });
await main();
console.log('\ndone');
