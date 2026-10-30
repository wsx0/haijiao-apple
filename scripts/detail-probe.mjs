// detail-probe.mjs —— 验证详情页路由的参数名（原生列表点条目要靠它）
//
// 已知：SPA 路由 path 是 "post/details"（无路径参数），所以参数一定在 query 里。
// 候选：?topicId=N / ?id=N
// 做法：先拿到一条真实帖子的标题，再用两个候选地址各打开一次，看页面里能不能出现这条标题。

import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const OUT = 'out8';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
           '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const HOME = 'https://haijiao.com/home';
const BLOCK = [
  '**/api/banner/banner_list*',
  '**/hjstore/system/banner/**',
  '**/www.google-analytics.com/**',
  '**/www.googletagmanager.com/**',
  '**/static.cloudflareinsights.com/**',
];

const decode2 = s => {
  const l1 = Buffer.from(s, 'base64');
  const txt = l1.toString('utf8');
  if (txt.trim().startsWith('{"')) return JSON.parse(txt);
  return JSON.parse(Buffer.from(txt.trim(), 'base64').toString('utf8'));
};

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'] });
  const ctx = await browser.newContext({
    userAgent: UA, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
    isMobile: true, hasTouch: true, locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
  });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  const page = await ctx.newPage();
  for (const p of BLOCK) await page.route(p, r => r.abort());

  // 0) 必须先落到站点上，否则页面还是 about:blank，相对路径 /api/... 解析不了
  try {
    await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1500);
  } catch (e) { console.log('首页打开失败:', e.message); }

  // 1) 直接打接口拿一条真实帖子（不走 UI，稳）
  let sample = null;
  try {
    const raw = await page.evaluate(async (ua) => {
      const r = await fetch('/api/topic/hot/topics?page=1', {
        headers: { 'accept': 'application/json, text/plain, */*', 'mver': '211112203214',
                   'x-user-id': 'null', 'x-user-token': 'null' },
      });
      return await r.text();
    }, UA);
    const env = JSON.parse(raw);
    const data = decode2(env.data);
    const first = (data.results || [])[0] || {};
    sample = { topicId: first.topicId, title: String(first.title || '').slice(0, 12) };
  } catch (e) {
    console.log('拿样本失败:', e.message);
  }
  console.log('样本:', JSON.stringify(sample));

  const result = { sample, candidates: [] };
  if (sample && sample.topicId) {
    const cands = [
      `${HOME.replace('/home', '')}/post/details?topicId=${sample.topicId}`,
      `${HOME.replace('/home', '')}/post/details?id=${sample.topicId}`,
    ];
    for (const url of cands) {
      const rec = { url };
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(4000);
        const info = await page.evaluate(() => {
          const txt = (document.body && document.body.innerText || '').replace(/\s+/g, ' ');
          return {
            title: document.title,
            url: location.href,
            textStart: txt.slice(0, 200),
            textLen: txt.length,
            hasCommentWord: /评论|条评论|发表/.test(txt),
            hasLikeWord: /点赞|赞/.test(txt),
          };
        });
        rec.finalUrl = info.url;
        rec.pageTitle = info.title;
        rec.textLen = info.textLen;
        rec.textStart = info.textStart;
        rec.hasCommentWord = info.hasCommentWord;
        rec.hasLikeWord = info.hasLikeWord;
        rec.titleHit = sample.title ? info.textStart.includes(sample.title.slice(0, 8)) : false;
        await page.screenshot({ path: path.join(OUT, `detail-${cands.indexOf(url)}.png`) });
      } catch (e) {
        rec.error = e.message;
      }
      console.log(`\n[${rec.url}]`);
      console.log('  finalUrl :', rec.finalUrl);
      console.log('  标题命中样本 :', rec.titleHit, ' 评论字样:', rec.hasCommentWord, ' 文本长度:', rec.textLen);
      console.log('  开头文本 :', (rec.textStart || '').slice(0, 120));
      result.candidates.push(rec);
    }
  }

  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, 'detail.json'), JSON.stringify(result, null, 2));
  await browser.close();
}

await fs.mkdir(OUT, { recursive: true });
await main();
console.log('\ndone');
