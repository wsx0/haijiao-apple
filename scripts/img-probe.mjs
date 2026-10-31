// img-probe.mjs —— 图片到底缺什么头
//
// 现象：列表能出、文字/统计都对，但缩略图是灰块。
// 图片在 pic.*.top 上，可能是 Referer 防盗链、WAF Cookie，或者需要和 API 一样的 mver/x-user-* 头。
// 这里用同一张真实图片，把各种头的组合全试一遍，看哪一种能拿到 JPEG/GIF 字节。

import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const OUT = 'out14';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
           '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const BASE = 'https://haijiao.com';

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

const magic = buf => {
  const b = [...buf.slice(0, 4)].map(x => x.toString(16).padStart(2, '0')).join('');
  if (b.startsWith('ffd8ff')) return 'JPEG';
  if (b.startsWith('89504e47')) return 'PNG';
  if (b.startsWith('47494638')) return 'GIF';
  if (b.startsWith('52494646')) return 'WEBP';
  if (b.startsWith('3c21444f') || b.startsWith('3c68746d')) return 'HTML!';
  return b;
};

async function main() {
  // 1) 找一张真实图片 URL（列表第一条带图的帖子）
  const r = await fetch(`${BASE}/api/topic/hot/topics?page=1`, {
    headers: {
      'User-Agent': UA, 'Accept': 'application/json, text/plain, */*',
      'Referer': `${BASE}/home`, 'mver': '211112203214',
      'x-user-id': 'null', 'x-user-token': 'null',
    },
  });
  const env = await r.json();
  const list = decodeLayers(env.data);
  let imgUrl = null, topicId = null;
  for (const t of (list.results || [])) {
    for (const a of (t.attachments || [])) {
      const u = a.coverUrl || a.remoteUrl;
      if (u && /\.(jpe?g|png|gif)(\.txt)?$/i.test(u)) { imgUrl = u; topicId = t.topicId; break; }
    }
    if (imgUrl) break;
  }
  if (!imgUrl) { console.log('没找到图片 URL'); return; }
  console.log('图片:', imgUrl);
  console.log('来自帖子:', topicId);

  const host = new URL(imgUrl).host;
  console.log('图片域名:', host);

  // 2) Node 层各种头组合
  const variants = [
    ['裸请求', {}],
    ['UA', { 'User-Agent': UA }],
    ['UA+Referer=home', { 'User-Agent': UA, 'Referer': `${BASE}/home` }],
    ['UA+Referer=根', { 'User-Agent': UA, 'Referer': `${BASE}/` }],
    ['UA+Referer=详情', { 'User-Agent': UA, 'Referer': `${BASE}/post/details?topicId=${topicId}` }],
    ['UA+Referer=图片自身', { 'User-Agent': UA, 'Referer': imgUrl }],
    ['UA+Referer=home+API头', {
      'User-Agent': UA, 'Referer': `${BASE}/home`,
      'mver': '211112203214', 'x-user-id': 'null', 'x-user-token': 'null',
      'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    }],
    ['全部+Origin', {
      'User-Agent': UA, 'Referer': `${BASE}/home`, 'Origin': BASE,
      'mver': '211112203214', 'x-user-id': 'null', 'x-user-token': 'null',
      'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    }],
  ];

  const results = [];
  for (const [name, headers] of variants) {
    try {
      const res = await fetch(imgUrl, { headers });
      const buf = Buffer.from(await res.arrayBuffer());
      const rec = {
        name, status: res.status,
        contentType: res.headers.get('content-type'),
        acao: res.headers.get('access-control-allow-origin'),
        length: buf.length, magic: magic(buf),
      };
      console.log(`  ${name.padEnd(22)} ${rec.status} ${String(rec.contentType).padEnd(24)} ${rec.length}B ${rec.magic} acao=${rec.acao}`);
      results.push(rec);
    } catch (e) {
      console.log(`  ${name.padEnd(22)} 失败: ${e.message}`);
      results.push({ name, error: e.message });
    }
  }

  // 3) 浏览器里的一手证据：<img> 与跨域 fetch
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({
    userAgent: UA, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-CN',
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3500);
  const browserTest = await page.evaluate(async (u) => {
    const out = {};
    // a) <img> 能不能加载（不受 CORS 限制）
    out.img = await new Promise(resolve => {
      const im = new Image();
      im.onload = () => resolve({ ok: true, w: im.naturalWidth, h: im.naturalHeight });
      im.onerror = () => resolve({ ok: false });
      im.src = u;
      setTimeout(() => resolve({ ok: false, timeout: true }), 8000);
    });
    // b) 跨域 fetch 能不能读字节（受 CORS 限制）
    try {
      const r = await fetch(u);
      const b = await r.arrayBuffer();
      out.fetch = { ok: true, status: r.status, len: b.byteLength };
    } catch (e) {
      out.fetch = { ok: false, err: String(e && e.message || e) };
    }
    return out;
  }, imgUrl);
  console.log('\n浏览器内:');
  console.log('  <img> 加载:', JSON.stringify(browserTest.img));
  console.log('  fetch 跨域:', JSON.stringify(browserTest.fetch));

  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, 'img-probe.json'), JSON.stringify({ imgUrl, topicId, host, results, browserTest }, null, 2));
  await browser.close();
}

await fs.mkdir(OUT, { recursive: true });
await main();
console.log('\ndone');
