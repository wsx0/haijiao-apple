// author-probe.mjs —— 作者主页：路由可用吗？数据靠哪个接口？
//
// 背景：现在点头像是 `onOpen(homepageURL)`，而 onOpen 会把整个 App 切到网页模式
// （mode = "web"），所以用户体感是「时不时跳网页」而且「进不了主页」。
// 要做原生作者页，必须知道：
//   1) /homepage/<uid> 这个路由是否真的渲染作者页
//   2) 它背后调什么 API（头像/昵称/帖子列表/关注状态）

import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const OUT = 'out36';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
           '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const BASE = 'https://haijiao.com';

const decodeLayers = payload => {
  let cur = String(payload).trim();
  for (let i = 0; i < 6; i++) {
    const buf = Buffer.from(cur, 'base64');
    const text = buf.toString('utf8');
    try { return JSON.parse(text); } catch (e) { cur = text.trim(); }
  }
  return null;
};

async function apiGet(pathname) {
  const r = await fetch(BASE + pathname, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*',
               'Referer': BASE + '/home', 'mver': '211112203214',
               'x-user-id': 'null', 'x-user-token': 'null' },
  });
  const t = await r.text();
  try { const e = JSON.parse(t); return e.data ? decodeLayers(e.data) : null; } catch { return null; }
}

async function main() {
  const out = {};

  // 1) 先拿一个真实 userId
  const list = await apiGet('/api/topic/hot/topics?page=1');
  const first = list?.results?.[0];
  const uid = first?.user?.id;
  console.log(`样本帖子 ${first?.topicId}，作者 id=${uid}，昵称=${first?.user?.nickname}`);
  out.sampleUserId = uid;
  out.sampleNickname = first?.user?.nickname;

  if (!uid) { console.log('拿不到 userId，退出'); return; }

  // 2) 试各种可能的作者接口
  const cands = [
    `/api/user/${uid}`,
    `/api/user/info/${uid}`,
    `/api/user/${uid}/topics?page=1`,
    `/api/user/${uid}/topic?page=1`,
    `/api/topic/user/${uid}/topics?page=1`,
    `/api/topic/user/topics?userId=${uid}&page=1`,
    `/api/user/homepage/${uid}`,
    `/api/homepage/${uid}`,
    `/api/user/${uid}/detail`,
  ];
  console.log('\n=== 作者接口探测 ===');
  out.apis = [];
  for (const p of cands) {
    const d = await apiGet(p);
    const ok = !!d;
    const n = d?.results?.length ?? (Array.isArray(d) ? d.length : 0);
    const keys = d ? Object.keys(d).slice(0, 8).join(',') : '';
    console.log(`${ok ? '✓' : '✗'} ${p.padEnd(48)} ${ok ? `n=${n} keys=${keys}` : ''}`);
    if (ok) out.apis.push({ path: p, n, keys: d ? Object.keys(d) : [] });
  }

  // 3) 打开 /homepage/<uid>，记录它发出的 API
  console.log(`\n=== 打开 /homepage/${uid} ===`);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const calls = [];
  const jsBodies = [];
  page.on('request', r => {
    const u = r.url();
    if (u.includes('/api/')) calls.push({ method: r.method(), url: u.replace(BASE, ''), body: r.postData() || '' });
  });
  page.on('response', async r => {
    const u = r.url();
    if (/\.js(\?|$)/.test(u)) { try { jsBodies.push({ url: u.replace(BASE, ''), body: await r.text() }); } catch (e) {} }
  });

  await page.goto(`${BASE}/homepage/${uid}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(6000);

  const info = await page.evaluate(() => ({
    title: document.title,
    url: location.href,
    // 页面上是否有昵称/帖子
    text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 400),
    hasList: document.querySelectorAll('[class*="item"], [class*="card"], [class*="topic"]').length,
  }));
  console.log(`标题: ${info.title}`);
  console.log(`最终 URL: ${info.url}`);
  console.log(`页面文本: ${info.text.slice(0, 220)}`);
  console.log(`列表元素数: ${info.hasList}`);
  out.page = info;

  console.log(`\n=== 该页面发出的 API（${calls.length}）===`);
  const uniq = [...new Map(calls.map(c => [c.url + c.body, c])).values()];
  for (const c of uniq.slice(0, 25)) {
    console.log(`  ${c.method} ${c.url}${c.body ? '  body=' + c.body.slice(0, 80) : ''}`);
  }
  out.calls = uniq;

  // 4) 从 JS 里挖 /homepage 相关组件
  console.log('\n=== JS 里 homepage 相关 ===');
  const hits = [];
  for (const s of jsBodies) {
    for (const kw of ['homepage', 'userHome', 'authorPage', 'user/info', 'userInfo']) {
      let i = s.body.indexOf(kw);
      let n = 0;
      while (i >= 0 && n < 2) {
        const ctx = s.body.slice(Math.max(0, i - 200), i + 300).replace(/\s+/g, ' ');
        if (/api|MyGet|MyPost|axios|request/i.test(ctx)) hits.push({ js: s.url, kw, ctx });
        i = s.body.indexOf(kw, i + kw.length); n++;
      }
    }
  }
  const uniqHits = [];
  const seen = new Set();
  for (const h of hits) {
    const k = h.ctx.slice(0, 60);
    if (!seen.has(k)) { seen.add(k); uniqHits.push(h); }
  }
  for (const h of uniqHits.slice(0, 6)) {
    console.log(`\n[${h.js}] ${h.kw}`);
    console.log('  ' + h.ctx.slice(0, 380));
  }
  out.jsHits = uniqHits.slice(0, 8);

  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, 'author.json'), JSON.stringify(out, null, 2));
  await browser.close();
}

await fs.mkdir(OUT, { recursive: true });
await main();
console.log('\ndone');
