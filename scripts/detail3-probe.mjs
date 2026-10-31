// detail3-probe.mjs —— 用运行时事实确定详情页 URL 形式
//
// 已知：详情页会请求 /api/topic/<id>，但参数名不是 topicId 也不是 id（实测都拼成 undefined）。
// 未知：id 到底从哪读（query 名？路径段？history.state？）
// 做法：把候选形式逐个真的打开，看哪一个能让 /api/topic/ 后面出现数字。
// 命中后顺带把详情接口的响应体存下来（原生化要用）。

import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const OUT = 'out10';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
           '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const BASE = 'https://haijiao.com';
const BLOCK = [
  '**/api/banner/banner_list*',
  '**/hjstore/system/banner/**',
  '**/www.google-analytics.com/**',
  '**/www.googletagmanager.com/**',
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
  if (!s) { console.log('样本获取失败'); return; }
  console.log(`样本 ${s.topicId} / ${String(s.title).slice(0, 16)}`);

  const id = s.topicId;
  const candidates = [
    `${BASE}/post/details?topicId=${id}`,
    `${BASE}/post/details?id=${id}`,
    `${BASE}/post/details?topic_id=${id}`,
    `${BASE}/post/details/${id}`,
    `${BASE}/post/${id}`,
    // 站点可能从「列表点击」时写入的 store 读，先打开首页再点第一条
    'HOME_THEN_CLICK',
  ];

  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'] });
  const results = [];

  for (const url of candidates) {
    const ctx = await browser.newContext({
      userAgent: UA, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
      isMobile: true, hasTouch: true, locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
    });
    await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
    const page = await ctx.newPage();
    for (const p of BLOCK) await page.route(p, r => r.abort());

    const hits = [];
    const resps = [];
    page.on('request', r => {
      const u = r.url();
      if (/\/api\/topic\//.test(u)) hits.push(r.method() + ' ' + u.replace(BASE, ''));
    });
    page.on('response', async r => {
      const u = r.url();
      if (!/\/api\/topic\//.test(u)) return;
      try {
        const t = await r.text();
        resps.push({ url: u, status: r.status(), body: t.slice(0, 60000) });
      } catch (e) {}
    });

    const rec = { candidate: url };
    try {
      if (url === 'HOME_THEN_CLICK') {
        await page.goto(`${BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(3500);
        // 点第一条能点的帖子（列表项带 topicId 的点击区域）
        const clicked = await page.evaluate((tid) => {
          const nodes = [...document.querySelectorAll('#app *')];
          const target = nodes.find(n => {
            const t = (n.innerText || '');
            return n.childElementCount <= 6 && t.length > 8 && t.length < 200 && n.onclick === null;
          });
          // 更靠得住：找带 @click 的列表项，直接派发点击
          const item = document.querySelector('#app .van-cell, #app .list-item, #app [class*="item"]');
          const el = item || target;
          if (!el) return false;
          el.click();
          return true;
        }, id);
        await page.waitForTimeout(4500);
        rec.clicked = clicked;
      } else {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(4500);
      }
      rec.finalUrl = page.url();
      rec.apiCalls = hits.slice(0, 8);
      rec.hasNumericTopic = hits.some(h => /\/api\/topic\/\d+/.test(h));
      rec.render = await page.evaluate(() => {
        const t = (document.body && document.body.innerText || '').replace(/\s+/g, ' ');
        return { len: t.length, head: t.slice(0, 120) };
      });
      rec.titleHit = String(s.title || '').slice(0, 8) ? rec.render.head.includes(String(s.title).slice(0, 8)) : false;
    } catch (e) {
      rec.error = e.message;
    }
    rec.responses = resps;
    results.push(rec);
    console.log(`\n[${url}]`);
    console.log(`  numeric=${rec.hasNumericTopic} titleHit=${rec.titleHit} len=${rec.render && rec.render.len}`);
    console.log(`  api: ${(rec.apiCalls || []).join(' | ').slice(0, 200)}`);
    await ctx.close();
    if (rec.hasNumericTopic && rec.titleHit) break;   // 命中就不用再试了
  }

  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, 'detail3.json'), JSON.stringify({ sample: { topicId: id, title: s.title }, results }, null, 2));
  const win = results.find(r => r.hasNumericTopic && r.titleHit) || results.find(r => r.hasNumericTopic);
  console.log('\n==> 命中：' + (win ? win.candidate : '无'));
  await browser.close();
}

await fs.mkdir(OUT, { recursive: true });
await main();
console.log('\ndone');
