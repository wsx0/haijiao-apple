// detail2-probe.mjs —— 详情页原生化第 1 步：抓详情/评论接口的真实契约
//
// 上一版 detail-probe 失败在「拿样本」：在页面上下文里 fetch 相对路径，页面还是 about:blank。
// 这次改成 Node 层 fetch（CI 的 node 有全局 fetch），三层 base64 解出真帖子，
// 再让浏览器真的打开详情页，全程拦截 /api/*，把请求头、方法、POST body、响应体全存下来。

import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const OUT = 'out9';
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

/// 三层 base64 → JSON
function decodeLayers(payload) {
  let cur = String(payload).trim();
  for (let i = 0; i < 6; i++) {
    const buf = Buffer.from(cur, 'base64');
    const text = buf.toString('utf8');
    try { return JSON.parse(text); } catch (e) { /* 继续下一层 */ }
    if (!text.trim()) break;
    cur = text.trim();
  }
  return null;
}

const slug = u => {
  try { const x = new URL(u); return (x.pathname + (x.search || '')).replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 60); }
  catch (e) { return 'x'; }
};

async function nodeFetchSample() {
  const r = await fetch(`${BASE}/api/topic/hot/topics?page=1`, {
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json, text/plain, */*',
      'Referer': `${BASE}/home`,
      'mver': '211112203214',
      'x-user-id': 'null',
      'x-user-token': 'null',
    },
  });
  const env = await r.json();
  const data = decodeLayers(env.data);
  const first = (data && data.results && data.results[0]) || null;
  return first;
}

async function main() {
  const sample = await nodeFetchSample();
  console.log('sample:', sample ? `${sample.topicId} / ${String(sample.title).slice(0, 20)}` : 'FAILED');

  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'] });
  const ctx = await browser.newContext({
    userAgent: UA, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
    isMobile: true, hasTouch: true, locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
  });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  const page = await ctx.newPage();
  for (const p of BLOCK) await page.route(p, r => r.abort());

  const caps = [];
  let idx = 0;
  page.on('request', r => {
    const u = r.url();
    if (!u.includes('/api/')) return;
    caps.push({ phase: 'req', tag: '', method: r.method(), url: u, headers: r.headers(), postData: (r.postData() || '').slice(0, 3000) });
  });
  page.on('response', async r => {
    const u = r.url();
    if (!u.includes('/api/')) return;
    const rec = { phase: 'res', tag: '', url: u, status: r.status(), headers: r.headers(), body: '' };
    try {
      const t = await r.text();
      rec.body = t.slice(0, 40000);
      if (t.length > 5) {
        const name = `${String(++idx).padStart(2, '0')}-${slug(u)}.json`;
        await fs.mkdir(path.join(OUT, 'bodies'), { recursive: true });
        await fs.writeFile(path.join(OUT, 'bodies', name), t);
        rec.savedAs = name;
      }
    } catch (e) {}
    caps.push(rec);
  });
  const mark = t => { for (const c of caps) if (!c.tag) c.tag = t; };

  let renderInfo = null;
  if (sample && sample.topicId) {
    const detailUrl = `${BASE}/post/details?topicId=${sample.topicId}`;
    // 候选 2：用 id 参数
    for (const [i, url] of [detailUrl, `${BASE}/post/details?id=${sample.topicId}`].entries()) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(6000);
        mark(`detail-${i}`);
        const info = await page.evaluate(() => {
          const txt = (document.body && document.body.innerText || '').replace(/\s+/g, ' ');
          return {
            url: location.href,
            textLen: txt.length,
            textStart: txt.slice(0, 300),
            hasComment: /评论|回复|\d+\s*条/.test(txt),
            imgCount: document.querySelectorAll('img').length,
          };
        });
        const hit = sample.title ? info.textStart.includes(String(sample.title).slice(0, 8)) : false;
        console.log(`\n[${url}]`);
        console.log(`  finalUrl=${info.url}`);
        console.log(`  标题命中=${hit} 文本长度=${info.textLen} img=${info.imgCount} 评论字样=${info.hasComment}`);
        console.log(`  开头：${info.textStart.slice(0, 160)}`);
        if (!renderInfo && hit) renderInfo = { url, ...info, hit };
        await page.screenshot({ path: path.join(OUT, `detail-${i}.png`) });
      } catch (e) {
        console.log(`[${url}] 打开失败: ${e.message}`);
      }
    }
  }

  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, 'detail-api.json'), JSON.stringify({
    sample: sample ? { topicId: sample.topicId, title: sample.title, node: sample.node, attachmentCount: (sample.attachments || []).length } : null,
    renderInfo, caps,
  }, null, 2));

  const reqs = caps.filter(c => c.phase === 'req');
  console.log(`\n捕获 ${reqs.length} 个 API 请求：`);
  for (const r of reqs) {
    console.log(`  [${r.tag}] ${r.method} ${r.url.replace(BASE, '')}` + (r.postData ? ` body=${r.postData.slice(0, 80)}` : ''));
  }
  console.log('\n响应体：');
  for (const c of caps.filter(x => x.phase === 'res' && x.savedAs)) {
    console.log(`  [${c.tag}] ${c.status} ${c.url.replace(BASE, '').slice(0, 70)} -> ${c.savedAs}`);
  }

  await browser.close();
}

await fs.mkdir(OUT, { recursive: true });
await main();
console.log('\ndone');
