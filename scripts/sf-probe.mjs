// sf-probe.mjs —— 抓 SleazyFork 上那个海角付费解析脚本，看它凭什么能出完整版
//
// 目的：脚本如果真的能解锁完整视频，那它的取流方式就是我缺的那一环。
// 做法：打开脚本页 → 取标题/描述 → 找代码链接 → 下载源码全文存盘。

import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const OUT = 'out26';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PAGE = 'https://sleazyfork.org/zh-CN/scripts/588095-%E9%85%A5%E7%93%A3%E4%BC%B4%E4%BE%A3-%E6%B5%B7%E8%A7%92%E7%AD%89%E6%88%90%E4%BA%BA%E7%A4%BE%E5%8C%BA%E4%BB%98%E8%B4%B9%E8%B5%84%E6%BA%90%E6%97%A0%E9%99%90%E8%A7%A3%E6%9E%90%E4%B8%8Evip%E7%A0%B4%E8%A7%A3';

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  const page = await ctx.newPage();

  const result = { page: PAGE, title: '', description: '', codeLinks: [], code: '', codeUrl: '' };

  try {
    await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(4000);
  } catch (e) {
    console.log('打开失败:', e.message);
    result.error = e.message;
  }

  const info = await page.evaluate(() => {
    const t = document.title || '';
    const desc = document.querySelector('#script-description, .script-description, #description')?.innerText || '';
    const links = [...document.querySelectorAll('a[href*="code"]')].map(a => a.href).slice(0, 8);
    const bodyText = (document.body.innerText || '').slice(0, 3000);
    return { t, desc: desc.slice(0, 3000), links, bodyText };
  });

  result.title = info.t;
  result.description = info.desc;
  result.codeLinks = info.links;
  console.log('标题:', info.t);
  console.log('\n--- 描述 ---');
  console.log((info.desc || info.bodyText).slice(0, 1500));

  // 找代码地址：优先 .user.js
  let codeUrl = info.links.find(l => /\.user\.js/.test(l)) || info.links.find(l => /\/code/.test(l));
  if (!codeUrl) {
    // 兜底：按 GreasyFork 惯例拼
    const id = 588095;
    const cands = [
      `https://update.sleazyfork.org/scripts/${id}/script.user.js`,
      `https://sleazyfork.org/scripts/${id}/code.user.js`,
      `https://sleazyfork.org/zh-CN/scripts/${id}/code`,
    ];
    for (const c of cands) {
      try {
        const r = await page.request.get(c, { headers: { 'User-Agent': UA, Referer: PAGE } });
        if (r.ok()) {
          const txt = await r.text();
          if (txt.length > 2000) { codeUrl = c; result.code = txt; break; }
        }
      } catch (e) {}
    }
  }

  if (!result.code && codeUrl) {
    try {
      const r = await page.request.get(codeUrl, { headers: { 'User-Agent': UA, Referer: PAGE } });
      result.code = await r.text();
    } catch (e) { console.log('取代码失败', e.message); }
  }
  result.codeUrl = codeUrl || '';

  console.log('\n代码地址:', result.codeUrl || '(未找到)');
  console.log('代码长度:', result.code.length);

  if (result.code) {
    // 挑跟「海角/赔付/解析/vip」相关的片段
    const keys = ['haijiao', 'hj', 'm3u8', 'preview', 'is_buy', 'buy', 'vip', 'unlock', 'decode', 'api/'];
    const hits = [];
    for (const k of keys) {
      let i = result.code.toLowerCase().indexOf(k.toLowerCase());
      let n = 0;
      while (i >= 0 && n < 3) {
        hits.push({ k, ctx: result.code.slice(Math.max(0, i - 150), i + 250).replace(/\s+/g, ' ') });
        i = result.code.toLowerCase().indexOf(k.toLowerCase(), i + 1);
        n++;
      }
    }
    result.hits = hits.slice(0, 30);
    console.log(`\n=== 关键词命中（${result.hits.length} 条，前 12）===`);
    for (const h of result.hits.slice(0, 12)) {
      console.log(`\n[${h.k}] ${h.ctx.slice(0, 320)}`);
    }
  }

  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, 'sf.json'), JSON.stringify(result, null, 2));
  if (result.code) await fs.writeFile(path.join(OUT, 'script.user.js'), result.code);
  await page.screenshot({ path: path.join(OUT, 'page.png'), fullPage: false }).catch(() => {});
  await browser.close();
}

await fs.mkdir(OUT, { recursive: true });
await main();
console.log('\ndone');
