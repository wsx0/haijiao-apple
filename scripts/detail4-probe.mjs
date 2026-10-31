// detail4-probe.mjs —— 从列表里真的点进详情，让站点自己给出正确 URL 与接口
//
// 前面试遍 5 种 URL 形式都拿到 /api/topic/undefined，说明 topicId 不是从 URL 读的，
// 而是点击列表项时写进 store/history.state 的。所以只能模拟真实点击：
// 用标题文本定位到最深节点，再逐层向上派发 click（总有一层挂着 Vue 的 @click）。

import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const OUT = 'out11';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
           '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const BASE = 'https://haijiao.com';
const BLOCK = [
  '**/api/banner/banner_list*', '**/hjstore/system/banner/**',
  '**/www.google-analytics.com/**', '**/www.googletagmanager.com/**',
  '**/static.cloudflareinsights.com/**',
];

function decodeLayers(payload) {
  let cur = String(payload).trim();
  for (let i = 0; i < 6; i++) {
    const buf = Buffer.from(cur, 'base64');
    const text = buf.toString('utf8');
    try { return JSON.parse(text); } catch (e) {}
    if (!text.trim()) break;
    cur = text.trim();
  }
  return null;
}

async function sample() {
  const r = await fetch(`${BASE}/api/topic/hot/topics?page=1`, {
    headers: {
      'User-Agent': UA, 'Accept': 'application/json, text/plain, */*',
      'Referer': `${BASE}/home`, 'mver': '211112203214',
      'x-user-id': 'null', 'x-user-token': 'null',
    },
  });
  const env = await r.json();
  const data = decodeLayers(env.data);
  return (data && data.results && data.results[0]) || null;
}

async function main() {
  const s = await sample();
  if (!s) { console.log('样本失败'); return; }
  const titleKey = String(s.title).slice(0, 6);
  console.log(`样本 ${s.topicId} / ${titleKey}`);

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
    if (u.includes('/api/')) apiLog.push({ m: r.method(), u: u.replace(BASE, ''), body: (r.postData() || '').slice(0, 500) });
  });
  page.on('response', async r => {
    const u = r.url();
    if (!/\/api\/(topic|comment|reply)\//.test(u)) return;
    try {
      const t = await r.text();
      const name = `${String(++n).padStart(2, '0')}-${u.replace(BASE, '').replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 50)}.json`;
      await fs.mkdir(path.join(OUT, 'bodies'), { recursive: true });
      await fs.writeFile(path.join(OUT, 'bodies', name), t.slice(0, 80000));
      saved.push({ url: u.replace(BASE, ''), status: r.status(), file: name, len: t.length });
    } catch (e) {}
  });

  await page.goto(`${BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4500);

  // 逐层向上派发 click
  const clicked = await page.evaluate((key) => {
    const all = [...document.querySelectorAll('#app *')];
    const leaf = all.find(el => el.children.length === 0 && (el.textContent || '').includes(key));
    if (!leaf) return 'no-leaf';
    let el = leaf;
    const tried = [];
    for (let i = 0; i < 7 && el && el !== document.body; i++) {
      tried.push(el.tagName + '.' + String(el.className || '').slice(0, 24));
      try {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      } catch (e) {}
      el = el.parentElement;
    }
    return tried.join(' > ');
  }, titleKey);
  console.log('点击链:', String(clicked).slice(0, 200));

  await page.waitForTimeout(6000);
  const after = await page.evaluate(() => ({
    url: location.href,
    textLen: (document.body && document.body.innerText || '').length,
    head: (document.body && document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 200),
  }));
  console.log('点击后 URL:', after.url);
  console.log('点击后文本长度:', after.textLen);
  console.log('开头:', after.head.slice(0, 140));

  // 如果成功了，再从详情页里点一条评论/再看是否有额外接口
  await page.waitForTimeout(2000);
  await page.evaluate(() => window.scrollBy(0, 1200));
  await page.waitForTimeout(2500);

  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, 'detail4.json'), JSON.stringify({
    sample: { topicId: s.topicId, title: s.title },
    clicked, after, apiLog, saved,
  }, null, 2));
  await page.screenshot({ path: path.join(OUT, 'after-click.png') });

  console.log(`\nAPI 调用 ${apiLog.length} 条，其中 topic/comment 响应 ${saved.length} 个`);
  for (const a of apiLog.slice(0, 20)) console.log(`  ${a.m} ${a.u}`);
  await browser.close();
}

await fs.mkdir(OUT, { recursive: true });
await main();
console.log('\ndone');
